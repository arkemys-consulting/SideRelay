import Foundation
import Security
import SwiftUI

struct SideRelayTVView: View {
    @StateObject private var connection = SideRelayTVConnection()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 32) {
                HStack(spacing: 32) {
                    Text("Signatures").font(.largeTitle.bold())
                    Spacer()
                    Button("Check Status", systemImage: "arrow.clockwise") {
                        Task { await connection.load() }
                    }
                    .buttonStyle(.bordered)
                    .disabled(connection.working)
                }

                if let message = connection.message {
                    Text(message).foregroundStyle(.secondary)
                }
                if connection.working {
                    ProgressView().accessibilityLabel("Contacting SideRelay")
                }
                if let apps = connection.apps {
                    if apps.isEmpty {
                        ContentUnavailableView("No Signed Apps", systemImage: "appletv",
                                               description: Text("Apps installed through SideRelay appear here."))
                    }
                    ForEach(apps) { app in
                        HStack(spacing: 28) {
                            Image(systemName: "app.fill")
                                .font(.title2).foregroundStyle(.tint)
                                .accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 6) {
                                Text(app.name).font(.headline)
                                if let state = app.state {
                                    Text(state).font(.callout).foregroundStyle(.secondary)
                                }
                            }
                            Spacer(minLength: 24)
                            if let expiry = app.expiresAt {
                                Text(Date(timeIntervalSince1970: expiry), format: .dateTime.month(.abbreviated).day().year())
                                    .foregroundStyle(.secondary)
                                    .accessibilityLabel(Text("Signature expires \(Date(timeIntervalSince1970: expiry).formatted(date: .abbreviated, time: .omitted))"))
                            }
                            Button("Refresh", systemImage: "arrow.clockwise") {
                                Task { await connection.refresh(app) }
                            }
                            .buttonStyle(.bordered)
                            .accessibilityLabel("Refresh \(app.name)")
                            .disabled(connection.working || !app.canRefresh || app.busy)
                        }
                        Divider()
                    }
                }
            }
            .padding(64)
            .frame(maxWidth: 1600)
        }
        .task { await connection.load() }
    }
}

private struct SideRelayTVApp: Decodable, Identifiable {
    let id: String
    let name: String
    let expiresAt: Double?
    let canRefresh: Bool
    let busy: Bool
    let state: String?
}

@MainActor
private final class SideRelayTVConnection: ObservableObject {
    @Published private(set) var apps: [SideRelayTVApp]?
    @Published private(set) var message: String?
    @Published private(set) var working = false

    private struct Status: Decodable {
        let apps: [SideRelayTVApp]
        let refreshJobID: String?
    }

    private struct Job: Decodable { let status: String }
    private struct Refresh: Encodable { let appID: String }

    func load() async {
        guard !working else { return }
        working = true
        message = nil
        defer { working = false }
        do {
            let status: Status = try await SideRelayTVAPI.request("status")
            apps = status.apps
            SideRelayTVSetup.recordConnection(appCount: status.apps.count)
        } catch is CancellationError {
            return
        } catch {
            message = explanation(error)
        }
    }

    func refresh(_ app: SideRelayTVApp) async {
        guard !working, app.canRefresh, !app.busy else { return }
        working = true
        message = "Requesting a refresh for \(app.name)…"
        defer { working = false }
        do {
            let result: Status = try await SideRelayTVAPI.request("refresh", payload: JSONEncoder().encode(Refresh(appID: app.id)))
            apps = result.apps
            guard let id = result.refreshJobID, UUID(uuidString: id) != nil else {
                message = "\(app.name) is already being refreshed."
                return
            }
            for _ in 0..<30 {
                try await Task.sleep(for: .seconds(2))
                let job: Job = try await SideRelayTVAPI.request("jobs/\(id)")
                switch job.status {
                case "done", "failed", "cancelled", "canceled":
                    message = job.status == "done" ? "\(app.name) refreshed." : "Check Activity in SideRelay for the refresh result."
                    let status: Status = try await SideRelayTVAPI.request("status")
                    apps = status.apps
                    return
                default: break
                }
            }
            message = "The refresh is still running. Check Status to see the latest result."
        } catch is CancellationError {
            return
        } catch {
            message = explanation(error)
        }
    }

    private func explanation(_ error: Error) -> String {
        switch error as? SideRelayTVAPI.ConnectionError {
        case .configuration: return "Set up this Apple TV in SideRelay on the Mac."
        case .denied: return "Connect this Apple TV to Tailscale and check its pairing in Devices."
        case .unavailable: return "Refresh is unavailable. Check Activity in SideRelay."
        case nil: return "Couldn’t reach SideRelay. Check that SideRelay is running and that both devices are connected to Tailscale."
        }
    }
}

@MainActor
enum SideRelayTVAPI {
    enum ConnectionError: Error { case configuration, denied, unavailable }

    static func request<Value: Decodable>(_ path: String, payload: Data? = nil, timeout: Double = 12) async throws -> Value {
        let settings = SideRelayTVSetup.settings
        guard let address = settings["address"], let base = URL(string: address),
              base.scheme == "https", let port = base.port, [19445, 19447].contains(port),
              base.host?.hasSuffix(".ts.net") == true,
              base.user == nil, base.password == nil, base.query == nil, base.fragment == nil,
              let device = settings["deviceID"], UUID(uuidString: device) != nil else {
            throw ConnectionError.configuration
        }
        var request = URLRequest(url: base.appendingPathComponent(path), timeoutInterval: timeout)
        request.setValue(device, forHTTPHeaderField: "X-SideRelay-Device")
        if let payload {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = payload
        }
        let (data, response) = try await URLSession.shared.data(for: request, delegate: SideRelayTVNoRedirect())
        guard let http = response as? HTTPURLResponse, http.url == request.url else { throw URLError(.badServerResponse) }
        if http.statusCode == 403 { throw ConnectionError.denied }
        if http.statusCode == 409 { throw ConnectionError.unavailable }
        guard http.statusCode == 200 else { throw URLError(.badServerResponse) }
        return try JSONDecoder().decode(Value.self, from: data)
    }
}

private final class SideRelayTVNoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest) async -> URLRequest? { nil }
}

@MainActor
enum SideRelayTVSetup {
    private static let cache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
    static var settings: [String: String] { Bundle.main.object(forInfoDictionaryKey: "SideRelayConnection") as? [String: String] ?? [:] }

    private struct Transfer: Decodable {
        let p12: Data
        let password: String
        let serial: String
        let revision: String
        let expiresAt: TimeInterval
    }

    static func importSigningIdentity() -> Bool {
        let staging = cache.appendingPathComponent("SideRelaySigning.json")
        guard let size = try? staging.resourceValues(forKeys: [.fileSizeKey]).fileSize else { return false }
        defer { try? FileManager.default.removeItem(at: staging) }
        guard settings["certificateSetup"] == "paired-v1", size < 70_000,
              let data = try? Data(contentsOf: staging),
              let transfer = try? JSONDecoder().decode(Transfer.self, from: data),
              transfer.revision == settings["revision"], !transfer.password.isEmpty,
              transfer.expiresAt > Date().timeIntervalSince1970, serial(of: transfer) == transfer.serial else { return false }
        do {
            try TVInstaller.importCertificate(transfer.p12, password: transfer.password)
            let receipt = ["serial": transfer.serial, "revision": transfer.revision]
            try JSONEncoder().encode(receipt).write(to: cache.appendingPathComponent("SideRelaySigningReady.json"), options: .atomic)
            return true
        } catch {
            return false
        }
    }

    private static func serial(of transfer: Transfer) -> String? {
        var items: CFArray?
        let options = [kSecImportExportPassphrase as String: transfer.password] as CFDictionary
        guard SecPKCS12Import(transfer.p12 as CFData, options, &items) == errSecSuccess,
              let record = (items as? [[String: Any]])?.first,
              let identity = record[kSecImportItemIdentity as String] else { return nil }
        var certificate: SecCertificate?
        guard SecIdentityCopyCertificate(identity as! SecIdentity, &certificate) == errSecSuccess,
              let certificate, let serial = SecCertificateCopySerialNumberData(certificate, nil) else { return nil }
        return String((serial as Data).map { String(format: "%02X", $0) }.joined().drop(while: { $0 == "0" }))
    }

    static func recordConnection(appCount: Int) {
        guard let revision = settings["revision"] else { return }
        let receipt = ["revision": revision, "apps": String(appCount), "date": Date().ISO8601Format()]
        try? JSONEncoder().encode(receipt).write(to: cache.appendingPathComponent("SideRelayConnectionReady.json"), options: .atomic)
    }
}
