const API_BASE = 'https://tele-be-production.up.railway.app/api';
const MOBILE_API_KEY = 'telematics-mobile-v1-rotate-me';


const axios = require('axios');

const API_HEADERS = {
  'X-API-Key': MOBILE_API_KEY,
};

const apiClient = axios.create({
  baseURL: API_BASE,
  timeout: 10000,
  headers: API_HEADERS,
});

async function createTrip(startLatitude, startLongitude) {
  const { data } = await apiClient.post('/trips/', {
    start_latitude: startLatitude,
    start_longitude: startLongitude,
  });
  return data;
}

async function addLocationPoint(tripId, latitude, longitude, speedKmh, accuracy, timestamp) {
  const payload = {
    latitude,
    longitude,
    speed_kmh: speedKmh,
  };

  if (accuracy != null && Number.isFinite(accuracy)) {
    payload.accuracy = accuracy;
  }

  if (timestamp) {
    payload.timestamp = timestamp;
  }

  const { data } = await apiClient.post(`/trips/${tripId}/locations/`, payload);
  return data;
}

async function addDrivingEvent(
  tripId,
  eventType,
  severity,
  speedKmhAtEvent,
  latitude,
  longitude,
  timestamp
) {
  const payload = {
    event_type: eventType,
    severity,
    speed_kmh_at_event: speedKmhAtEvent,
    timestamp: timestamp || new Date().toISOString(),
  };

  if (latitude != null && Number.isFinite(latitude)) {
    payload.latitude = latitude;
  }

  if (longitude != null && Number.isFinite(longitude)) {
    payload.longitude = longitude;
  }

  const { data } = await apiClient.post(`/trips/${tripId}/events/`, payload);
  return data;
}

async function endTrip(tripId, endLatitude, endLongitude, endTimeIso, averageSpeedKmh, totalDistanceKm, harshBrakingCount, harshAccelerationCount, crashDetected, crashLatitude, crashLongitude, harshEvents, speedingDurationSeconds, speedingViolationsCount, maxSpeedOverLimit) {
  const payload = {
    end_latitude: endLatitude,
    end_longitude: endLongitude,
    end_time: endTimeIso,
    average_speed_kmh: averageSpeedKmh,
    total_distance_km: totalDistanceKm,
    harsh_braking_count: harshBrakingCount,
    harsh_acceleration_count: harshAccelerationCount,
    crash_detected: crashDetected,
    harsh_events: harshEvents || [], // Array of harsh events with locations
    speeding_duration_seconds: speedingDurationSeconds || 0,
    speeding_violations_count: speedingViolationsCount || 0,
    max_speed_over_limit: maxSpeedOverLimit || 0,
  };
  
  // Only include crash location if crash was detected
  if (crashDetected && crashLatitude != null && crashLongitude != null) {
    payload.crash_latitude = crashLatitude;
    payload.crash_longitude = crashLongitude;
  }
  
  const { data } = await apiClient.patch(`/trips/${tripId}/`, payload);
  return data;
}

module.exports = {
  API_BASE,
  API_HEADERS,
  MOBILE_API_KEY,
  createTrip,
  addLocationPoint,
  addDrivingEvent,
  endTrip,
};
