from django.conf import settings
from datetime import timedelta

from django.test import override_settings
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APITestCase

from .metrics import summarize_location_points
from .models import DrivingEvent, LocationPoint, Trip


TEST_MIDDLEWARE = [
    middleware
    for middleware in settings.MIDDLEWARE
    if middleware != 'whitenoise.middleware.WhiteNoiseMiddleware'
]


@override_settings(
    MOBILE_API_KEY='test-mobile-key',
    DEBUG=False,
    MIDDLEWARE=TEST_MIDDLEWARE,
    SECURE_SSL_REDIRECT=False,
)
class TripsApiTests(APITestCase):
    def setUp(self):
        self.client.credentials(HTTP_X_API_KEY='test-mobile-key')

    def create_trip(self):
        return Trip.objects.create(
            start_latitude=33.8938,
            start_longitude=35.5018,
        )

    def test_trip_list_requires_mobile_api_key(self):
        self.client.credentials()

        response = self.client.get('/api/trips/')

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_location_endpoint_is_idempotent_for_duplicate_points(self):
        trip = self.create_trip()
        timestamp = timezone.now().replace(microsecond=0)
        payload = {
            'latitude': 33.8938,
            'longitude': 35.5018,
            'timestamp': timestamp.isoformat(),
            'speed_kmh': 24.5,
            'accuracy': 6,
        }

        first_response = self.client.post(f'/api/trips/{trip.id}/locations/', payload, format='json')
        second_response = self.client.post(f'/api/trips/{trip.id}/locations/', payload, format='json')

        self.assertEqual(first_response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(second_response.status_code, status.HTTP_200_OK)
        self.assertEqual(trip.location_points.count(), 1)

    def test_trip_patch_recomputes_summary_and_preserves_existing_events(self):
        trip = self.create_trip()
        start_time = timezone.now().replace(microsecond=0)

        LocationPoint.objects.create(
            trip=trip,
            latitude=33.8938,
            longitude=35.5018,
            timestamp=start_time,
            speed_kmh=0,
            accuracy=6,
        )
        LocationPoint.objects.create(
            trip=trip,
            latitude=33.8947,
            longitude=35.5018,
            timestamp=start_time + timedelta(seconds=10),
            speed_kmh=35,
            accuracy=6,
        )

        existing_event = DrivingEvent.objects.create(
            trip=trip,
            event_type='braking',
            timestamp=start_time + timedelta(seconds=5),
            latitude=33.8941,
            longitude=35.5018,
            severity='moderate',
            speed_kmh_at_event=28,
        )

        expected_distance_km, expected_average_speed_kmh = summarize_location_points(
            trip.location_points.all()
        )

        payload = {
            'end_latitude': 33.8947,
            'end_longitude': 35.5018,
            'end_time': (start_time + timedelta(seconds=12)).isoformat(),
            'average_speed_kmh': 999,
            'total_distance_km': 999,
            'harsh_braking_count': 0,
            'harsh_acceleration_count': 0,
            'harsh_events': [
                {
                    'type': 'braking',
                    'timestamp': existing_event.timestamp.isoformat(),
                    'latitude': existing_event.latitude,
                    'longitude': existing_event.longitude,
                    'speed': existing_event.speed_kmh_at_event,
                },
                {
                    'type': 'acceleration',
                    'timestamp': (start_time + timedelta(seconds=7)).isoformat(),
                    'latitude': 33.8943,
                    'longitude': 35.5018,
                    'speed': 33,
                },
            ],
        }

        response = self.client.patch(f'/api/trips/{trip.id}/', payload, format='json')
        trip.refresh_from_db()

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(trip.total_distance_km, expected_distance_km)
        self.assertEqual(trip.average_speed_kmh, expected_average_speed_kmh)
        self.assertEqual(trip.driving_events.count(), 2)
        self.assertEqual(trip.harsh_braking_count, 1)
        self.assertEqual(trip.harsh_acceleration_count, 1)
        self.assertIsNotNone(trip.safety_score)

    def test_trip_patch_rejects_invalid_end_time(self):
        trip = self.create_trip()

        response = self.client.patch(
            f'/api/trips/{trip.id}/',
            {'end_time': 'not-a-date'},
            format='json',
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
