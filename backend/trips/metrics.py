from math import atan2, cos, radians, sin, sqrt

MAX_USABLE_ACCURACY_METERS = 45.0


def distance_km(lat1, lng1, lat2, lng2):
    earth_radius_km = 6371
    d_lat = radians(lat2 - lat1)
    d_lng = radians(lng2 - lng1)
    a = (
        sin(d_lat / 2) ** 2
        + cos(radians(lat1)) * cos(radians(lat2)) * sin(d_lng / 2) ** 2
    )
    c = 2 * atan2(sqrt(a), sqrt(1 - a))
    return earth_radius_km * c


def summarize_location_points(points):
    ordered_points = list(points.order_by('timestamp'))
    total_distance_km = 0.0

    if len(ordered_points) < 2:
        return 0.0, 0.0

    for previous, current in zip(ordered_points, ordered_points[1:]):
        delta_seconds = (current.timestamp - previous.timestamp).total_seconds()
        if delta_seconds <= 0 or delta_seconds > 30:
            continue

        distance_meters = distance_km(
            previous.latitude,
            previous.longitude,
            current.latitude,
            current.longitude,
        ) * 1000

        accuracies = [
            value
            for value in (previous.accuracy, current.accuracy)
            if isinstance(value, (int, float)) and value > 0
        ]
        max_accuracy = max(accuracies) if accuracies else 25.0
        if max_accuracy > MAX_USABLE_ACCURACY_METERS:
            continue
        noise_floor_meters = max(max_accuracy * 0.55, 5.0)
        if distance_meters <= noise_floor_meters:
            continue

        segment_speed_kmh = (distance_meters / delta_seconds) * 3.6
        if segment_speed_kmh > 180:
            continue

        total_distance_km += distance_meters / 1000

    duration_seconds = (
        ordered_points[-1].timestamp - ordered_points[0].timestamp
    ).total_seconds()
    average_speed_kmh = (
        total_distance_km / (duration_seconds / 3600) if duration_seconds > 0 else 0.0
    )

    return round(total_distance_km, 2), round(average_speed_kmh, 1)
