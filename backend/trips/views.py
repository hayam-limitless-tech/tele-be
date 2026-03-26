import json
import os
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from django.db import transaction
from django.utils import timezone
from django.utils.dateparse import parse_datetime

# Create your views here.
from rest_framework import status
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView
from django.shortcuts import get_object_or_404
from .metrics import summarize_location_points
from .models import Trip, LocationPoint, DrivingEvent
from .serializers import TripSerializer, LocationPointSerializer, DrivingEventSerializer

GOOGLE_ROADS_SPEED_LIMITS_URL = 'https://roads.googleapis.com/v1/speedLimits'


def parse_request_datetime(value, field_name):
    if value in (None, ''):
        return None
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        parsed = parse_datetime(value)
    else:
        parsed = None

    if parsed is None:
        raise ValidationError({field_name: 'Invalid ISO-8601 datetime.'})

    if timezone.is_naive(parsed):
        parsed = timezone.make_aware(parsed, timezone.get_current_timezone())
    return parsed


def normalize_harsh_event_payload(trip_id, event):
    if not isinstance(event, dict):
        raise ValidationError({'harsh_events': 'Each driving event must be an object.'})
    return {
        'trip': trip_id,
        'event_type': event.get('event_type') or event.get('type'),
        'timestamp': event.get('timestamp'),
        'latitude': event.get('latitude'),
        'longitude': event.get('longitude'),
        'severity': event.get('severity') or 'moderate',
        'speed_kmh_at_event': event.get('speed_kmh_at_event', event.get('speed', 0.0)),
    }


def upsert_location_point(validated_data):
    location_point, created = LocationPoint.objects.get_or_create(
        trip=validated_data['trip'],
        timestamp=validated_data['timestamp'],
        latitude=validated_data['latitude'],
        longitude=validated_data['longitude'],
        defaults={
            'speed_kmh': validated_data.get('speed_kmh', 0.0),
            'accuracy': validated_data.get('accuracy'),
        },
    )
    return location_point, created


def upsert_driving_event(validated_data):
    driving_event, created = DrivingEvent.objects.get_or_create(
        trip=validated_data['trip'],
        event_type=validated_data['event_type'],
        timestamp=validated_data['timestamp'],
        latitude=validated_data.get('latitude'),
        longitude=validated_data.get('longitude'),
        defaults={
            'severity': validated_data.get('severity', 'moderate'),
            'speed_kmh_at_event': validated_data.get('speed_kmh_at_event', 0.0),
        },
    )
    return driving_event, created


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
        except urllib.error.HTTPError as e:
            # Google returned 4xx/5xx. 403/401 = key invalid or Roads API not enabled.
            if e.code in (401, 403):
                return Response(
                    {'detail': 'Speed limit service unavailable (check GOOGLE_MAPS_API_KEY and enable Roads API in Google Cloud).'},
                    status=status.HTTP_503_SERVICE_UNAVAILABLE,
                )
            return Response(
                {'detail': f'Upstream error from speed limit provider (HTTP {e.code}).'},
                status=status.HTTP_502_BAD_GATEWAY,
            )
        except (urllib.error.URLError, json.JSONDecodeError, OSError) as e:
            return Response(
                {'detail': str(getattr(e, 'reason', e)) or 'Speed limit service temporarily unavailable.'},
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

        harsh_events = data.get('harsh_events') if 'harsh_events' in data else None
        validated_harsh_events = None
        if harsh_events is not None:
            if not isinstance(harsh_events, list):
                raise ValidationError({'harsh_events': 'Expected a list of driving events.'})
            normalized_events = [
                normalize_harsh_event_payload(trip_id, event)
                for event in harsh_events
            ]
            event_serializer = DrivingEventSerializer(data=normalized_events, many=True)
            event_serializer.is_valid(raise_exception=True)
            validated_harsh_events = event_serializer.validated_data

        with transaction.atomic():
            if 'end_latitude' in data:
                trip.end_latitude = data.get('end_latitude', trip.end_latitude)
            if 'end_longitude' in data:
                trip.end_longitude = data.get('end_longitude', trip.end_longitude)
            if 'end_time' in data:
                trip.end_time = parse_request_datetime(data.get('end_time'), 'end_time')
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

            if validated_harsh_events is not None:
                for event_data in validated_harsh_events:
                    upsert_driving_event(event_data)

            if trip.driving_events.exists():
                trip.harsh_braking_count = trip.driving_events.filter(event_type='braking').count()
                trip.harsh_acceleration_count = trip.driving_events.filter(
                    event_type='acceleration'
                ).count()

            computed_distance_km, computed_average_speed_kmh = summarize_location_points(
                trip.location_points.all()
            )
            if computed_distance_km > 0:
                trip.total_distance_km = computed_distance_km
                trip.average_speed_kmh = computed_average_speed_kmh

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
            location_point, created = upsert_location_point(serializer.validated_data)
            response_serializer = LocationPointSerializer(location_point)
            return Response(
                response_serializer.data,
                status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
            )
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)


class DrivingEventListCreateView(APIView):
    """POST: record a driving event (acceleration/braking) for a trip."""

    def post(self, request, trip_id):
        trip = get_object_or_404(Trip, pk=trip_id)
        data = {**request.data, 'trip': trip_id}
        serializer = DrivingEventSerializer(data=data)
        if serializer.is_valid():
            driving_event, created = upsert_driving_event(serializer.validated_data)
            response_serializer = DrivingEventSerializer(driving_event)
            return Response(
                response_serializer.data,
                status=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
            )
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
