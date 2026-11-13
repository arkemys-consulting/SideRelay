use base64::{Engine, engine::general_purpose::STANDARD};
use idevice::{
    IdeviceError, IdeviceService, RemoteXpcClient,
    core_device_proxy::CoreDeviceProxy,
    provider::RsdProvider,
    remote_pairing::{
        PAIRABLE_HOST_SERVICE_TYPE, PairableHost, PairableHostInfo, RemotePairingClient,
        RemotePairingLockdownService, RpPairingFile, RpPairingSocket,
    },
    rsd::RsdHandshake,
    usbmuxd::{Connection, UsbmuxdAddr, UsbmuxdConnection},
};
use mdns_sd::{ServiceDaemon, ServiceInfo};
use serde_json::{Value, json};
use std::{io::{self, Write}, net::{IpAddr, Ipv4Addr}, time::Duration};
use tokio::net::TcpListener;

const HOST: &str = "SideRelay";
const SERVICE: &str = "com.apple.internal.dt.coredevice.untrusted.tunnelservice";
type Result<T> = std::result::Result<T, &'static str>;

fn emit(value: Value) {
    let mut out = io::stdout().lock();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}

fn state(stage: &str) { emit(json!({"stage": stage})); }

fn paired(file: &RpPairingFile, address: Option<Ipv4Addr>) {
    emit(json!({"stage": "record", "record": STANDARD.encode(file.to_bytes()), "address": address.map(|ip| ip.to_string())}));
}

fn normalize(id: &str) -> String { id.replace('-', "").to_ascii_uppercase() }

// Uses Apple's existing USB trust relationship and its CoreDevice service.
// The Remote Pairing exchange follows idevice_pair v1.1.0 (MIT, Jackson Coxson).
async fn usb(id: &str, label: &str, probe: bool, simplified: bool) -> Result<()> {
    let mut mux = UsbmuxdConnection::default().await.map_err(|_| "usbUnavailable")?;
    let devices = mux.get_devices().await.map_err(|_| "usbUnavailable")?;
    let id = normalize(id);
    let device = devices.iter().find(|d| d.connection_type == Connection::Usb && normalize(&d.udid) == id)
        .ok_or("usbDisconnected")?;
    let provider = device.to_provider(UsbmuxdAddr::default(), HOST);
    state("usbConnect");
    if simplified { match RemotePairingLockdownService::connect(&provider).await {
        Ok(service) => {
            if probe { state("usbReady"); return Ok(()); }
            let mut client = service.into_client(label).map_err(|_| "usbUnavailable")?;
            let mut file = RpPairingFile::generate(label);
            state("usbApprove");
            client.connect(&mut file, || async { "000000".to_string() }).await
                .map_err(|_| "usbApprovalFailed")?;
            paired(&file, None);
            return Ok(());
        }
        Err(IdeviceError::ServiceNotFound) => {}
        Err(IdeviceError::UnknownErrorType(message)) if message == "InvalidService" => {}
        Err(_) => return Err("usbTrust"),
    } }
    // Only use the older service if the new service is absent; don't repeat a declined prompt.
    let proxy = CoreDeviceProxy::connect(&provider).await.map_err(|_| "usbTrust")?;
    let rsd_port = proxy.tunnel_info().server_rsd_port;
    let mut handle = proxy.create_software_tunnel().map_err(|_| "usbUnavailable")?.to_async_handle();
    let stream = handle.connect(rsd_port).await.map_err(|_| "usbUnavailable")?;
    let rsd = RsdHandshake::new(stream).await.map_err(|_| "usbUnavailable")?;
    let port = rsd.services.get(SERVICE).ok_or("usbUnsupported")?.port;
    if probe { state("usbReady"); return Ok(()); }
    let mut file = RpPairingFile::generate(label);
    for stage in ["usbApprove", "usbConfirm"] {
        state(stage);
        let stream = handle.connect_to_service_port(port).await.map_err(|_| "usbUnavailable")?;
        let mut client = RemoteXpcClient::new(stream).await.map_err(|_| "usbUnavailable")?;
        client.do_handshake().await.map_err(|_| "usbUnavailable")?;
        let _ = client.recv_root().await;
        let mut pairing = RemotePairingClient::new(client, label);
        pairing.connect(&mut file, || async { "000000".to_string() }).await.map_err(|_| "usbApprovalFailed")?;
    }
    paired(&file, None);
    Ok(())
}

struct Advertisement { daemon: ServiceDaemon, name: String }
impl Drop for Advertisement {
    fn drop(&mut self) {
        let _ = self.daemon.unregister(&self.name);
        let _ = self.daemon.shutdown();
    }
}

async fn wifi(local: Ipv4Addr, probe: bool) -> Result<()> {
    let listener = TcpListener::bind((local, 0)).await.map_err(|_| "wifiUnavailable")?;
    let port = listener.local_addr().map_err(|_| "wifiUnavailable")?.port();
    let identity = PairableHostInfo::generate(HOST, "Mac17,7");
    let mut file = RpPairingFile::generate(HOST);
    let identifier = &file.identifier;
    let daemon = ServiceDaemon::new().map_err(|_| "wifiUnavailable")?;
    daemon.set_service_name_len_max(30).map_err(|_| "wifiUnavailable")?;
    let records = identity.mdns_txt_records(identifier);
    let properties: Vec<_> = records.iter().map(|(key, value)| (key.as_str(), value.as_str())).collect();
    let service = ServiceInfo::new(PAIRABLE_HOST_SERVICE_TYPE, identifier,
        &format!("siderelay-{}.local.", &identifier[..8]), IpAddr::V4(local), port,
        &properties[..]).map_err(|_| "wifiUnavailable")?;
    let name = service.get_fullname().to_owned();
    daemon.register(service).map_err(|_| "wifiUnavailable")?;
    let _advertisement = Advertisement { daemon, name };
    state("wifiWait");
    if probe { tokio::time::sleep(Duration::from_secs(6)).await; return Ok(()); }
    let (stream, address) = listener.accept().await.map_err(|_| "wifiUnavailable")?;
    state("wifiConnected");
    let mut host = PairableHost::new(RpPairingSocket::new_device(stream), identity);
    host.accept(&mut file, |pin| async move { emit(json!({"stage":"wifiCode", "code":pin})); })
        .await.map_err(|_| "wifiApprovalFailed")?;
    let std::net::IpAddr::V4(peer) = address.ip() else { return Err("wifiUnavailable"); };
    paired(&file, Some(peer));
    Ok(())
}

async fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    match args.as_slice() {
        [_, mode, id, label] if matches!(mode.as_str(), "usb" | "usb-simple") && label.starts_with("SideRelay-") && label.len() <= 30 =>
            usb(id, label, false, mode == "usb-simple").await,
        [_, mode, id] if mode == "probe-usb" => usb(id, HOST, true, true).await,
        [_, mode, address] if mode == "wifi" || mode == "probe-wifi" =>
            wifi(address.parse().map_err(|_| "wifiUnavailable")?, mode == "probe-wifi").await,
        _ => Err("invalidSelection"),
    }
}

fn main() {
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().thread_stack_size(8 * 1024 * 1024).build()
        .unwrap_or_else(|_| { state("startFailed"); std::process::exit(1); });
    let outcome = runtime.block_on(async { tokio::time::timeout(Duration::from_secs(120), run()).await });
    match outcome {
        Ok(Ok(())) => {},
        Ok(Err(reason)) => { state(reason); std::process::exit(1); },
        Err(_) => { state("timedOut"); std::process::exit(1); },
    }
}
