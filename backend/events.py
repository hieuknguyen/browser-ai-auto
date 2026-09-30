import asyncio
import time


class EventBus:
    """Bounded queues keep slow viewers off the input execution path."""

    def __init__(self):
        self.sequence = 0
        self.queues: set[asyncio.Queue] = set()

    def publish(self, type: str, **payload) -> dict:
        self.sequence += 1
        event = {**payload, "type": type, "sequence": self.sequence, "timestamp": int(time.time() * 1000)}
        for queue in tuple(self.queues):
            if queue.full():
                if type == "browser:frame":
                    continue
                # Reconnection fetches authoritative state if an observer falls behind.
                while not queue.empty():
                    queue.get_nowait()
                queue.put_nowait({"type": "resync", "sequence": self.sequence, "timestamp": event["timestamp"]})
                continue
            queue.put_nowait(event)
        return event

    def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=128)
        self.queues.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue):
        self.queues.discard(queue)
