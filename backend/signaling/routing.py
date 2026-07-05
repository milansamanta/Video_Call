from django.urls import re_path
from . import consumers
from typing import cast, Any

websocket_urlpatterns = [
    re_path(r'ws/call/(?P<room_name>\w+)/$', cast(Any, consumers.VideoCallConsumer.as_asgi())),
]