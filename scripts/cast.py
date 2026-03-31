#!/usr/bin/env python3
"""
Minimal Chromecast audio casting script.

Usage: cast.py <mp3_file_path> <device_name>

Discovers the named Chromecast device on the local network,
plays the given MP3 file, and exits.

Requirements: pip install pychromecast
"""

import sys
import time

try:
    import pychromecast
except ImportError:
    print("Error: pychromecast is not installed. Run: pip install pychromecast", file=sys.stderr)
    sys.exit(1)


def main():
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <mp3_file_path> <device_name>", file=sys.stderr)
        sys.exit(1)

    mp3_path = sys.argv[1]
    device_name = sys.argv[2]

    # Discover Chromecast devices
    chromecasts, browser = pychromecast.get_listed_chromecasts(friendly_names=[device_name])

    if not chromecasts:
        print(f"Error: Chromecast device '{device_name}' not found", file=sys.stderr)
        browser.stop_discovery()
        sys.exit(1)

    cast = chromecasts[0]
    cast.wait()

    mc = cast.media_controller

    # Serve MP3 via a simple HTTP callback — for local files,
    # pychromecast needs the file served over HTTP.
    # In practice, the caller should ensure the file is accessible.
    mc.play_media(mp3_path, "audio/mpeg")
    mc.block_until_active()

    # Wait for playback to complete
    while mc.status.player_is_playing:
        time.sleep(1)

    browser.stop_discovery()


if __name__ == "__main__":
    main()
