"""
Export Trip, LocationPoint, and DrivingEvent data to CSV files.
Usage (with Render DB): set DATABASE_URL, then:
  python manage.py export_tables
Output: backend/exports/trips.csv, location_points.csv, driving_events.csv
"""
import csv
import os
from django.core.management.base import BaseCommand
from django.utils import timezone
from trips.models import Trip, LocationPoint, DrivingEvent


def safe_str(val):
    if val is None:
        return ""
    if isinstance(val, timezone.datetime):
        return val.isoformat()
    return str(val)


class Command(BaseCommand):
    help = "Export trips, location points, and driving events to CSV files."

    def add_arguments(self, parser):
        parser.add_argument(
            "--output-dir",
            type=str,
            default="exports",
            help="Directory to write CSV files (default: exports)",
        )

    def handle(self, *args, **options):
        out_dir = options["output_dir"]
        os.makedirs(out_dir, exist_ok=True)

        # Trips
        trips_path = os.path.join(out_dir, "trips.csv")
        with open(trips_path, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow([
                "id", "start_time", "end_time",
                "start_latitude", "start_longitude", "end_latitude", "end_longitude",
                "average_speed_kmh", "safety_score",
            ])
            for t in Trip.objects.all().order_by("id"):
                w.writerow([
                    t.id, safe_str(t.start_time), safe_str(t.end_time),
                    t.start_latitude, t.start_longitude,
                    safe_str(t.end_latitude), safe_str(t.end_longitude),
                    t.average_speed_kmh, safe_str(t.safety_score),
                ])
        self.stdout.write(self.style.SUCCESS(f"Wrote {trips_path}"))

        # Location points
        loc_path = os.path.join(out_dir, "location_points.csv")
        with open(loc_path, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["id", "trip_id", "latitude", "longitude", "timestamp", "speed_kmh", "accuracy"])
            for p in LocationPoint.objects.all().select_related("trip").order_by("trip_id", "timestamp"):
                w.writerow([
                    p.id, p.trip_id, p.latitude, p.longitude,
                    safe_str(p.timestamp), p.speed_kmh, safe_str(p.accuracy),
                ])
        self.stdout.write(self.style.SUCCESS(f"Wrote {loc_path}"))

        # Driving events
        ev_path = os.path.join(out_dir, "driving_events.csv")
        with open(ev_path, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["id", "trip_id", "event_type", "severity", "timestamp", "speed_kmh_at_event"])
            for e in DrivingEvent.objects.all().order_by("trip_id", "timestamp"):
                w.writerow([
                    e.id, e.trip_id, e.event_type, e.severity,
                    safe_str(e.timestamp), e.speed_kmh_at_event,
                ])
        self.stdout.write(self.style.SUCCESS(f"Wrote {ev_path}"))

        self.stdout.write(self.style.SUCCESS(f"Done. All CSVs are in: {os.path.abspath(out_dir)}"))
