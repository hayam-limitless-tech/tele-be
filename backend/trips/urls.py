from django.urls import path
from . import views

app_name = 'trips'

urlpatterns = [
    path('', views.TripListCreateView.as_view(), name='trip-list-create'),
    path('<int:trip_id>/', views.TripDetailView.as_view(), name='trip-detail'),
    path('<int:trip_id>/locations/', views.LocationPointListCreateView.as_view(), name='location-list-create'),
    path('<int:trip_id>/events/', views.DrivingEventListCreateView.as_view(), name='event-list-create'),
]