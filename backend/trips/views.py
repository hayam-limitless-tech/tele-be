from django.shortcuts import render

# Create your views here.
from rest_framework import status
from rest_framework.views import APIView
from rest_framework.response import Response
from django.shortcuts import get_object_or_404
from .models import Trip, LocationPoint, DrivingEvent
from .serializers import TripSerializer, LocationPointSerializer, DrivingEventSerializer


def calculate_safety_score(trip):
    """Compute safety score 0-100 from trip data and events."""
    score = 100.0
    # Penalty per event by severity
    penalties = {'mild': 2, 'moderate': 5, 'severe': 10}
    for event in trip.driving_events.all():
        score -= penalties.get(event.severity, 2)
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
        if 'end_latitude' is not None:
            trip.end_latitude = data.get('end_latitude', trip.end_latitude)
        if 'end_longitude' is not None:
            trip.end_longitude = data.get('end_longitude', trip.end_longitude)
        if 'end_time' is not None:
            trip.end_time = data.get('end_time')
        if 'average_speed_kmh' is not None:
            trip.average_speed_kmh = data['average_speed_kmh']
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