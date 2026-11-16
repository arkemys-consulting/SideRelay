"""Discover iPhone and iPad services on the Docker host's multicast network."""

from concurrent.futures import ThreadPoolExecutor
from ipaddress import IPv4Address
from threading import Lock
import time


SERVICES = ("_remotepairing._tcp.local.", "_apple-mobdev2._tcp.local.")


def bonjour():
    from zeroconf import IPVersion, ServiceBrowser, Zeroconf

    services = set()
    lock = Lock()

    class Listener:
        def add_service(self, _, service, name):
            with lock:
                services.add((service, name))

        update_service = add_service

        def remove_service(self, _, service, name):
            with lock:
                services.discard((service, name))

    with Zeroconf(ip_version=IPVersion.V4Only) as connection:
        browser = ServiceBrowser(connection, list(SERVICES), listener=Listener())
        try:
            time.sleep(1.6)
            with lock:
                candidates = sorted(services)[:64]
        finally:
            browser.cancel()
        with ThreadPoolExecutor(max_workers=8) as pool:
            resolved = pool.map(lambda item: connection.get_service_info(*item, timeout=650), candidates)
            hosts = {}
            for result in resolved:
                if not result or not result.server:
                    continue
                label = result.server.removesuffix(".local.")
                if "appletv" in "".join(c for c in label.lower() if c.isalpha()):
                    continue
                addresses = [IPv4Address(ip) for ip in result.parsed_addresses(IPVersion.V4Only)]
                address = next((ip for ip in addresses if not ip.is_loopback and not ip.is_link_local), None)
                if address and (label not in hosts or result.type == SERVICES[0]):
                    hosts[label] = {"name": label, "address": str(address), "remotePairing": result.type == SERVICES[0]}
    return {"status": "ready", "devices": sorted(hosts.values(), key=lambda device: device["name"].casefold())}
