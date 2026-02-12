const API_BASE = 'https://tele-be-production.up.railway.app/api';


const axios = require('axios');

async function createTrip(startLatitude, startLongitude) {
  const { data } = await axios.post(`${API_BASE}/trips/`, {
    start_latitude: startLatitude,
    start_longitude: startLongitude,
  });
  return data;
}

async function addLocationPoint(tripId, latitude, longitude, speedKmh) {
  const { data } = await axios.post(`${API_BASE}/trips/${tripId}/locations/`, {
    latitude,
    longitude,
    speed_kmh: speedKmh,
  });
  return data;
}

async function addDrivingEvent(tripId, eventType, severity, speedKmhAtEvent) {
  const { data } = await axios.post(`${API_BASE}/trips/${tripId}/events/`, {
    event_type: eventType,
    severity,
    speed_kmh_at_event: speedKmhAtEvent,
  });
  return data;
}

async function endTrip(tripId, endLatitude, endLongitude, endTimeIso, averageSpeedKmh, totalDistanceKm, harshBrakingCount, harshAccelerationCount, crashDetected, crashLatitude, crashLongitude, harshEvents) {
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
  };
  
  // Only include crash location if crash was detected
  if (crashDetected && crashLatitude != null && crashLongitude != null) {
    payload.crash_latitude = crashLatitude;
    payload.crash_longitude = crashLongitude;
  }
  
  const { data } = await axios.patch(`${API_BASE}/trips/${tripId}/`, payload);
  return data;
}

module.exports = { createTrip, addLocationPoint, addDrivingEvent, endTrip, API_BASE };