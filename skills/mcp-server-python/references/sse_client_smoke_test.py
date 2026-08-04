"""Smoke-test an SSE MCP server.

Usage:
    python sse_client_smoke_test.py http://127.0.0.1:8777/sse
"""
import asyncio
import sys

from mcp import ClientSession
from mcp.client.sse import sse_client


async def main(url: str) -> None:
    async with sse_client(url) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            print("tools:", [t.name for t in tools.tools])

            # Try get_status if it exists; otherwise just list tools.
            if any(t.name == "get_status" for t in tools.tools):
                result = await session.call_tool("get_status", {})
                print("get_status:", result.content[0].text)


if __name__ == "__main__":
    url = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8777/sse"
    asyncio.run(main(url))
