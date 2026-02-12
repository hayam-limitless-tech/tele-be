from django.db import models

# Create your models here.

class Trip(models.Model):
    """One driving trip: from start to stop."""

    start_time = models.DateTimeField(auto_now_add=True)
    end_time = models.DateTimeField(null=True, blank=True)
    start_latitude = models.FloatField()
    start_longitude = models.FloatField()
    end_latitude = models.FloatField(null=True, blank=True)
    end_longitude = models.FloatField(null=True, blank=True)
    average_speed_kmh = models.FloatField(default=0.0)
    total_distance_km = models.FloatField(default=0.0)
    harsh_braking_count = models.IntegerField(default=0)
    harsh_acceleration_count = models.IntegerField(default=0)
    crash_detected = models.BooleanField(default=False)
    crash_latitude = models.FloatField(null=True, blank=True)
    crash_longitude = models.FloatField(null=True, blank=True)
    speeding_duration_seconds = models.IntegerField(default=0)  # Total time spent speeding
    speeding_violations_count = models.IntegerField(default=0)  # Number of speeding incidents
    max_speed_over_limit = models.FloatField(default=0.0)  # Highest km/h over limit
    safety_score = models.FloatField(null=True, blank=True)

    class Meta:
        ordering = ['-start_time']

    def __str__(self):
        return f"Trip {self.id} started {self.start_time}"


class LocationPoint(models.Model):
    """One GPS point recorded during a trip."""

    trip = models.ForeignKey(Trip, on_delete=models.CASCADE, related_name='location_points')
    latitude = models.FloatField()
    longitude = models.FloatField()
    timestamp = models.DateTimeField(auto_now_add=True)
    speed_kmh = models.FloatField(default=0.0)
    accuracy = models.FloatField(null=True, blank=True)

    class Meta:
        ordering = ['timestamp']

    def __str__(self):
        return f"Point at ({self.latitude}, {self.longitude})"


class DrivingEvent(models.Model):
    """Sudden acceleration or braking during a trip."""

    EVENT_TYPES = [
        ('acceleration', 'Sudden acceleration'),
        ('braking', 'Sudden braking'),
    ]

    SEVERITY_LEVELS = [
        ('mild', 'Mild'),
        ('moderate', 'Moderate'),
        ('severe', 'Severe'),
    ]

    trip = models.ForeignKey(Trip, on_delete=models.CASCADE, related_name='driving_events')
    event_type = models.CharField(max_length=20, choices=EVENT_TYPES)
    timestamp = models.DateTimeField()
    latitude = models.FloatField(null=True, blank=True)
    longitude = models.FloatField(null=True, blank=True)
    severity = models.CharField(max_length=20, choices=SEVERITY_LEVELS, default='mild')
    speed_kmh_at_event = models.FloatField(default=0.0)

    class Meta:
        ordering = ['timestamp']

    def __str__(self):
        return f"{self.get_event_type_display()} ({self.severity})"


"""
Trip
start_time / end_time: when the trip started/ended.
start_latitude / start_longitude, end_latitude / end_longitude: start/end positions.
average_speed_kmh: average speed in km/h.
safety_score: score you’ll compute (e.g. 0-100).

LocationPoint
trip: links this point to one Trip.
latitude, longitude, timestamp, speed_kmh, accuracy: one GPS sample.

DrivingEvent
trip: links to one Trip.
event_type: 'acceleration' or 'braking'.
severity: 'mild', 'moderate', 'severe'.
speed_kmh_at_event: speed when the event happened.

"""