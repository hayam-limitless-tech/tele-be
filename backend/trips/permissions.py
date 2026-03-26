from django.conf import settings
from django.utils.crypto import constant_time_compare
from rest_framework.exceptions import APIException
from rest_framework.permissions import BasePermission


class MobileApiKeyNotConfigured(APIException):
    status_code = 503
    default_detail = 'Mobile API key is not configured on the server.'
    default_code = 'mobile_api_key_not_configured'


class HasMobileApiKey(BasePermission):
    message = 'A valid X-API-Key header is required.'

    def has_permission(self, request, view):
        configured_key = (getattr(settings, 'MOBILE_API_KEY', '') or '').strip()
        if not configured_key:
            raise MobileApiKeyNotConfigured()

        provided_key = (request.headers.get('X-API-Key') or '').strip()
        if not provided_key:
            return False

        return constant_time_compare(provided_key, configured_key)
