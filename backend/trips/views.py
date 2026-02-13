import json
import os
import urllib.error
import urllib.parse
import urllib.request
from django.shortcuts import render

# Create your views here.
from rest_framework import status
from rest_framework.views import APIView
from rest_framework.response import Response
from django.shortcuts import get_object_or_404
from .models import Trip, LocationPoint, DrivingEvent
from .serializers import TripSerializer, LocationPointSerializer, DrivingEventSerializer

GOOGLE_ROADS_SPEED_LIMITS_URL = 'https://roads.googleapis.com/v1/speedLimits'


class SpeedLimitView(APIView):
    """
    GET ?lat=...&lng=... → proxy to Google Roads API Speed Limits.
    API key is read from GOOGLE_MAPS_API_KEY env (e.g. on Railway).
    Returns same shape as mobile expects: { speedLimit, source, ... } or 404.
    """

    def get(self, request):
        api_key = os.environ.get('GOOGLE_MAPS_API_KEY', '').strip()
        if not api_key:
            return Response(
                {'detail': 'Google Maps API key not configured'},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        lat = request.query_params.get('lat')
        lng = request.query_params.get('lng')
        if lat is None or lng is None:
            return Response(
                {'detail': 'lat and lng query parameters required'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            path = f'{lat},{lng}'
            url = f'{GOOGLE_ROADS_SPEED_LIMITS_URL}?path={urllib.parse.quote(path)}&units=KPH&key={urllib.parse.quote(api_key)}'
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read().decode())
        except (urllib.error.HTTPError, urllib.error.URLError, json.JSONDecodeError, OSError) as e:
            return Response(
                {'detail': str(getattr(e, 'reason', e))},
                status=status.HTTP_502_BAD_GATEWAY,
            )
        speed_limits = data.get('speedLimits') or []
        if not speed_limits or speed_limits[0].get('speedLimit') is None:
            return Response(
                {'detail': 'No speed limit data for this location'},
                status=status.HTTP_404_NOT_FOUND,
            )
        item = speed_limits[0]
        value = item['speedLimit']
        units = (item.get('units') or 'KPH').upper()
        speed_kmh = round(value * 1.60934) if units == 'MPH' else value
        return Response({
            'speedLimit': speed_kmh,
            'source': 'google',
            'osmSpeed': None,
            'roadType': None,
            'legalLimit': speed_kmh,
        })


def calculate_safety_score(trip):
    """Compute safety score 0-100 from trip summary data."""
    score = 100.0
    # Penalty per harsh event
    penalty_per_brake = 5
    penalty_per_accel = 4
    crash_penalty = 50  # Severe penalty for crash
    score -= trip.harsh_braking_count * penalty_per_brake
    score -= trip.harsh_acceleration_count * penalty_per_accel
    if trip.crash_detected:
        score -= crash_penalty
    
    # Speeding penalties
    # 1 point per 30 seconds of speeding (max 20 points)
    speeding_minutes = trip.speeding_duration_seconds / 60.0
    speeding_penalty = min(20, speeding_minutes / 0.5)  # 1 point per 30 seconds
    score -= speeding_penalty
    
    # Additional penalty based on how much over the limit
    if trip.max_speed_over_limit > 0:
        # 1 point per 5 km/h over limit (max 10 points)
        excess_penalty = min(10, trip.max_speed_over_limit / 5.0)
        score -= excess_penalty
    
    # Penalty for high average speed (e.g. over 90 km/h)
    if trip.average_speed_kmh and trip.average_speed_kmh > 90:
        score -= min(20, (trip.average_speed_kmh - 90) * 0.5)
    return max(0.0, min(100.0, score))


class TripListCreateView(APIView):
    """POST: start a new trip. GET: list recent trips."""

    def post(self, request):
        data = request.data
        serializer = TripSerializer(data=data)
        if serializer.is_valid():
            serializer.save()
            return Response(serializer.data, status=status.HTTP_201_CREATED)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

    def get(self, request):
        trips = Trip.objects.all()[:20]
        serializer = TripSerializer(trips, many=True)
        return Response(serializer.data)


class TripDetailView(APIView):
    """GET one trip. PATCH: end trip and set end location + average speed + safety score."""

    def get(self, request, trip_id):
        trip = get_object_or_404(Trip, pk=trip_id)
        serializer = TripSerializer(trip)
        return Response(serializer.data)

    def patch(self, request, trip_id):
        trip = get_object_or_404(Trip, pk=trip_id)
        data = request.data
        if 'end_latitude' in data:
            trip.end_latitude = data.get('end_latitude', trip.end_latitude)
        if 'end_longitude' in data:
            trip.end_longitude = data.get('end_longitude', trip.end_longitude)
        if 'end_time' in data:
            trip.end_time = data.get('end_time')
        if 'average_speed_kmh' in data:
            trip.average_speed_kmh = data['average_speed_kmh']
        if 'total_distance_km' in data:
            trip.total_distance_km = data['total_distance_km']
        if 'harsh_braking_count' in data:
            trip.harsh_braking_count = data['harsh_braking_count']
        if 'harsh_acceleration_count' in data:
            trip.harsh_acceleration_count = data['harsh_acceleration_count']
        if 'crash_detected' in data:
            trip.crash_detected = data['crash_detected']
        if 'crash_latitude' in data:
            trip.crash_latitude = data['crash_latitude']
        if 'crash_longitude' in data:
            trip.crash_longitude = data['crash_longitude']
        if 'speeding_duration_seconds' in data:
            trip.speeding_duration_seconds = data['speeding_duration_seconds']
        if 'speeding_violations_count' in data:
            trip.speeding_violations_count = data['speeding_violations_count']
        if 'max_speed_over_limit' in data:
            trip.max_speed_over_limit = data['max_speed_over_limit']
        
        # Process harsh events array if provided
        if 'harsh_events' in data:
            for event in data['harsh_events']:
                DrivingEvent.objects.create(
                    trip=trip,
                    event_type=event['type'],  # 'braking' or 'acceleration'
                    timestamp=event['timestamp'],
                    latitude=event['latitude'],
                    longitude=event['longitude'],
                    speed_kmh_at_event=event.get('speed', 0.0),
                    severity='moderate'  # Default severity
                )
        
        trip.safety_score = calculate_safety_score(trip)
        trip.save()
        serializer = TripSerializer(trip)
        return Response(serializer.data)


class LocationPointListCreateView(APIView):
    """POST: add a location point to a trip."""

    def post(self, request, trip_id):
        trip = get_object_or_404(Trip, pk=trip_id)
        data = {**request.data, 'trip': trip_id}
        serializer = LocationPointSerializer(data=data)
        if serializer.is_valid():
            serializer.save()
            return Response(serializer.data, status=status.HTTP_201_CREATED)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)


class DrivingEventListCreateView(APIView):
    """POST: record a driving event (acceleration/braking) for a trip."""

    def post(self, request, trip_id):
        trip = get_object_or_404(Trip, pk=trip_id)
        data = {**request.data, 'trip': trip_id}
        serializer = DrivingEventSerializer(data=data)
        if serializer.is_valid():
            serializer.save()
            return Response(serializer.data, status=status.HTTP_201_CREATED)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)