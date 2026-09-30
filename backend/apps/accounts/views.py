from django.contrib.auth import get_user_model
from rest_framework import generics, status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework_simplejwt.views import TokenObtainPairView, TokenRefreshView

from common.throttling import AuthThrottle

from .serializers import LoginSerializer, ProfileUpdateSerializer, RegisterSerializer, UserSerializer

User = get_user_model()


class RegisterView(generics.CreateAPIView):
    """POST /api/auth/register/ — sign up and bootstrap a workspace."""

    serializer_class = RegisterSerializer
    permission_classes = [AllowAny]
    throttle_classes = [AuthThrottle]
    throttle_scope = "auth"

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = serializer.save()
        return Response(serializer.to_representation(user), status=status.HTTP_201_CREATED)


class LoginView(TokenObtainPairView):
    """POST /api/auth/token/ — SimpleJWT pair with tenant claims."""

    serializer_class = LoginSerializer
    permission_classes = [AllowAny]
    throttle_classes = [AuthThrottle]
    throttle_scope = "auth"


class RefreshView(TokenRefreshView):
    """POST /api/auth/token/refresh/."""

    permission_classes = [AllowAny]
    throttle_classes = [AuthThrottle]
    throttle_scope = "auth"


class MeView(generics.RetrieveUpdateAPIView):
    """GET / PATCH /api/auth/me/."""

    serializer_class = UserSerializer

    def get_object(self):
        return self.request.user

    def get_serializer_class(self):
        if self.request.method in ("PATCH", "PUT"):
            return ProfileUpdateSerializer
        return UserSerializer

    def to_representation(self, instance):
        serializer = UserSerializer(instance, context=self.get_serializer_context())
        return serializer.data
