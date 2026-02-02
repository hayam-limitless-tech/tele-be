from django.contrib import admin
from .models import Trip, LocationPoint, DrivingEvent


@admin.register(Trip)
class TripAdmin(admin.ModelAdmin):
    list_display = ['id', 'start_time', 'end_time', 'average_speed_kmh', 'safety_score']


@admin.register(LocationPoint)
class LocationPointAdmin(admin.ModelAdmin):
    list_display = ['id', 'trip', 'latitude', 'longitude', 'timestamp', 'speed_kmh']


@admin.register(DrivingEvent)
class DrivingEventAdmin(admin.ModelAdmin):
    list_display = ['id', 'trip', 'event_type', 'severity', 'timestamp', 'speed_kmh_at_event']