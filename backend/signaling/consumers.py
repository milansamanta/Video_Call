from channels.generic.websocket import AsyncWebsocketConsumer
import json

class VideoCallConsumer(AsyncWebsocketConsumer):
    async def connect(self) -> None:
        self.room_name = self.scope.get('url_route', {})['kwargs']['room_name']
        self.group_name = f"call_{self.room_name}"

        await self.channel_layer.group_add(
            self.group_name,
            self.channel_name
        )
        await self.accept()
        await self.channel_layer.group_send(
            self.group_name,
            {
                'type': 'peer_joined',
                'sender': self.channel_name,
            }
        )

    
    async def disconnect(self, code: int) -> None:
        await self.channel_layer.group_send(
            self.group_name,
            {
                'type': 'peer_left',
                'sender': self.channel_name,
            }
        )

        await self.channel_layer.group_discard(
            self.group_name,
            self.channel_name
        )
    
    async def receive(self, text_data: str | None = None, bytes_data: bytes | None = None) -> None:
        if not text_data:
            raise ValueError("No text data found")
        data = json.loads(text_data)
        await self.channel_layer.group_send(
            self.group_name,
            {
                'type': 'signal_message',
                'sender': self.channel_name,
                'message': data
            }
        )

    async def signal_message(self, event):
        if self.channel_name == event['sender']:
            return
        await self.send(text_data=json.dumps({'type': 'signal', 'message':event['message']}))

    async def peer_joined(self, event):
        if self.channel_name == event['sender']:
            return
        await self.send(text_data=json.dumps({'type': 'peer_joined', 'sender': event['sender']}))

    async def peer_left(self, event):
        if self.channel_name == event['sender']:
            return
        await self.send(text_data=json.dumps({'type': 'peer_left', 'sender': event['sender']}))