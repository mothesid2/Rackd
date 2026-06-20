import asyncio
import json

PORT = 5000
HOST = "11.11.20.78"

# Handle each TCP client
async def handle_client(reader, writer):
    addr = writer.get_extra_info('peername')
    print(f"Connection from {addr}")

    # Prepare JSON message
    json_message = json.dumps({
        "TRAN_MODE": "1",
        "TRAN_CODE": "1",
        "AMOUNT": "100"
    }) + "\n"  # Add delimiter for message boundary

    # Send message to client
    writer.write(json_message.encode())
    await writer.drain()
    print(f"Sent: {json_message.strip()}")

    try:
        while True:
            # Read data (line-based for simplicity)
            data = await reader.readline()
            if not data:
                break

            message = data.decode().strip()
            print(f"Received: {message}")

            # Echo response
            response = f"Server received your message: {message}\n"
            writer.write(response.encode())
            await writer.drain()
            print(f"Sent: {response.strip()}")

    except Exception as e:
        print(f"Error: {e}")

    finally:
        print(f"Connection closed: {addr}")
        writer.close()
        await writer.wait_closed()


# Main server
async def main():
    server = await asyncio.start_server(handle_client, HOST, PORT)
    print(f"TCP server running on {HOST}:{PORT}")

    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())