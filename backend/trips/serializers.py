from rest_framework import serializers
from .models import Trip, LocationPoint, DrivingEvent


class TripSerializer(serializers.ModelSerializer):
    class Meta:
        model = Trip
        fields = [
            'id', 'start_time', 'end_time',
            'start_latitude', 'start_longitude',
            'end_latitude', 'end_longitude',
            'average_speed_kmh', 'total_distance_km',
            'harsh_braking_count', 'harsh_acceleration_count',
            'crash_detected', 'crash_latitude', 'crash_longitude',
            'safety_score',
        ]
        read_only_fields = ['id', 'start_time', 'average_speed_kmh', 'safety_score']


class LocationPointSerializer(serializers.ModelSerializer):
    class Meta:
        model = LocationPoint
        fields = ['id', 'trip', 'latitude', 'longitude', 'timestamp', 'speed_kmh', 'accuracy']
        read_only_fields = ['id', 'timestamp']


class DrivingEventSerializer(serializers.ModelSerializer):
    class Meta:
        model = DrivingEvent
        fields = ['id', 'trip', 'event_type', 'timestamp', 'severity', 'speed_kmh_at_event']
        read_only_fields = ['id', 'timestamp']