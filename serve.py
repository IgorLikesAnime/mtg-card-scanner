#!/usr/bin/env python3
"""Tiny static server for the MTG Card Scanner.

The webcam (getUserMedia) only works from a "secure context" — https OR
http://localhost. Serving on localhost is the easy path, and because WSL2
forwards Windows localhost to the WSL listener, opening http://localhost:8000
in your Windows browser hits this server and the camera is allowed.

Usage:  python3 serve.py [port]
"""
import http.server
import os
import socketserver
import subprocess
import sys
import webbrowser

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
os.chdir(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # never cache during development
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # quiet


def open_browser(url: str) -> None:
    """Best-effort: open a Windows browser from WSL, else the default browser."""
    for cmd in (["cmd.exe", "/c", "start", "", url], ["explorer.exe", url]):
        try:
            subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return
        except FileNotFoundError:
            continue
    try:
        webbrowser.open(url)
    except Exception:
        pass


if __name__ == "__main__":
    url = f"http://localhost:{PORT}"
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        print(f"\n  MTG Card Scanner running at:  {url}")
        print("  Open that URL in your browser, then allow camera access.")
        print("  Press Ctrl+C to stop.\n")
        open_browser(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")
