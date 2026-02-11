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

async function endTrip(tripId, endLatitude, endLongitude, endTimeIso, averageSpeedKmh) {
  const { data } = await axios.patch(`${API_BASE}/trips/${tripId}/`, {
    end_latitude: endLatitude,
    end_longitude: endLongitude,
    end_time: endTimeIso,
    average_speed_kmh: averageSpeedKmh,
  });
  return data;
}

module.exports = { createTrip, addLocationPoint, addDrivingEvent, endTrip, API_BASE };