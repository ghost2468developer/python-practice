"""Uniform error envelope across the API."""
import logging

from rest_framework.views import exception_handler as drf_exception_handler

logger = logging.getLogger("orbit.api")


def exception_handler(exc, context):
    response = drf_exception_handler(exc, context)
    if response is None:
        logger.exception("Unhandled API exception", exc_info=exc)
        return None

    detail = response.data
    if isinstance(detail, dict) and "detail" in detail and len(detail) == 1:
        payload = {"detail": str(detail["detail"]), "code": getattr(exc, "default_code", "error")}
    else:
        payload = detail
    response.data = payload
    return response
