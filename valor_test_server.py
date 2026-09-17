import asyncio
import json
from datetime import datetime

PORT = 5000
HOST = "0.0.0.0"   # listen on ALL interfaces (this PC's IPv4 is 11.11.20.189)
                   # NOTE: 11.11.20.78 (the engineer's value) is the TERMINAL's IP,
                   # not this PC's — binding it fails with WinError 10049.


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


async def handle_client(reader, writer):
    addr = writer.get_extra_info('peername')
    log(f"*** TERMINAL CONNECTED from {addr} ***")

    json_message = json.dumps({
        "TRAN_MODE": "1",
        "TRAN_CODE": "1",
        "AMOUNT": "100",
    }) + "\n"

    writer.write(json_message.encode())
    await writer.drain()
    log(f"Sent: {json_message.strip()}")

    try:
        while True:
            data = await reader.readline()
            if not data:
                break
            message = data.decode(errors='replace').strip()
            log(f"Received: {message}")
            response = f"Server received your message: {message}\n"
            writer.write(response.encode())
            await writer.drain()
            log(f"Sent: {response.strip()}")
    except Exception as e:
        log(f"Error: {e}")
    finally:
        log(f"Connection closed: {addr}")
        writer.close()
        await writer.wait_closed()


async def main():
    server = await asyncio.start_server(handle_client, HOST, PORT)
    for sock in server.sockets:
        log(f"Listening on {sock.getsockname()}")
    log(f"Point the VP100's Valor Connect at  11.11.20.189 : {PORT}  then Param-Download it.")
    log("Waiting for the terminal to connect...")
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
