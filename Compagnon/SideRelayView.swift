import Foundation
import Security
import SwiftUI

@MainActor
enum SideRelaySigning {
    private static let defaults = LCUtils.appGroupUserDefault
    private static let cache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
    private static let staging = cache.appendingPathComponent("SideRelaySigning.json")
    private static let receipt = cache.appendingPathComponent("SideRelaySigningReady.json")

    private struct Transfer: Decodable {
        let p12: Data
        let password: String
        let serial: String
        let revision: String
        let expiresAt: TimeInterval
    }

    private struct Receipt: Encodable {
        let serial: String
        let revision: String
    }

    static var isConfigured: Bool {
        defaults.data(forKey: "LCCertificateData") != nil &&
            !(defaults.string(forKey: "LCCertificatePassword") ?? "").isEmpty
    }

    static func clearReceipt() {
        try? FileManager.default.removeItem(at: receipt)
    }

    static func finalizeSetup() {
        guard FileManager.default.fileExists(atPath: staging.path) else { return }
        defer { try? FileManager.default.removeItem(at: staging) }
        let config = Bundle.main.object(forInfoDictionaryKey: "SideRelayConnection") as? [String: String]
        guard config?["certificateSetup"] == "paired-v1",
              let data = try? Data(contentsOf: staging), data.count < 70_000,
              let transfer = try? JSONDecoder().decode(Transfer.self, from: data),
              !transfer.password.isEmpty, transfer.revision == config?["revision"],
              Date().timeIntervalSince1970 < transfer.expiresAt,
              let team = LCSharedUtils.teamIdentifier(),
              LCUtils.getCertTeamId(withKeyData: transfer.p12, password: transfer.password) == team,
              serial(of: transfer) == transfer.serial else { return }

        defaults.set(transfer.p12, forKey: "LCCertificateData")
        defaults.set(transfer.password, forKey: "LCCertificatePassword")
        defaults.set(Date(), forKey: "LCCertificateUpdateDate")
        UserDefaults.standard.set(LCSharedUtils.appGroupID(), forKey: "LCAppGroupID")
        guard isConfigured,
              let reply = try? JSONEncoder().encode(Receipt(serial: transfer.serial, revision: transfer.revision)) else { return }
        try? reply.write(to: receipt, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    private static func serial(of transfer: Transfer) -> String? {
        var items: CFArray?
        let options = [kSecImportExportPassphrase as String: transfer.password] as CFDictionary
        guard SecPKCS12Import(transfer.p12 as CFData, options, &items) == errSecSuccess,
              let identity = (items as? [[String: Any]])?.first?[kSecImportItemIdentity as String] else { return nil }
        // Security supplies a SecIdentity in kSecImportItemIdentity on success.
        var certificate: SecCertificate?
        guard SecIdentityCopyCertificate(identity as! SecIdentity, &certificate) == errSecSuccess,
              let certificate, let serial = SecCertificateCopySerialNumberData(certificate, nil) else { return nil }
        let hex = (serial as Data).map { String(format: "%02X", $0) }.joined()
        return String(hex.drop(while: { $0 == "0" }))
    }
}

struct SideRelayAppStatus: View {
    @EnvironmentObject private var companion: SideRelayConnection

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let issue = companion.connectionIssue {
                Label(issue, systemImage: "exclamationmark.circle")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                if !companion.loading {
                    Button("Check Connection") { Task { await companion.load() } }
                }
            }
            if let message = companion.refreshMessage {
                Text(message).font(.subheadline).foregroundStyle(.secondary)
            }
            if companion.status == nil && companion.loading {
                ProgressView("Loading installed apps…")
            }
        }
    }
}

struct SideRelayInstalledAppRow: View {
    let app: ManagedApp

    @EnvironmentObject private var companion: SideRelayConnection
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var icon: UIImage?

    var body: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 4) {
                    appDetails
                    refreshButton
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                HStack(spacing: 12) {
                    appDetails
                    Spacer(minLength: 0)
                    refreshButton
                }
            }
        }
        .padding(14)
        .frame(minHeight: 88)
        .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 22))
        .task(id: app.iconLoadKey) {
            let image = await companion.installedAppIcon(app)
            if !Task.isCancelled { icon = image }
        }
    }

    private var appDetails: some View {
        HStack(spacing: 10) {
            Group {
                if let icon {
                    Image(uiImage: icon).resizable().scaledToFit()
                } else {
                    Image(systemName: "app.fill")
                        .font(.system(size: 22))
                        .foregroundStyle(.secondary)
                }
            }
            .frame(width: 48, height: 48)
            .background(Color(uiColor: .tertiarySystemFill))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .accessibilityHidden(true)
            details
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(app.name).font(.headline)
            Text(SideRelayConnection.expiryText(app.expiresAt))
                .font(.subheadline)
                .foregroundStyle(app.expiresAt.map { SideRelayConnection.expiryColor($0) } ?? .secondary)
            if let state = app.state {
                Text(state).font(.subheadline).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder private var refreshButton: some View {
        if app.canRefresh {
            Button { Task { await companion.refresh(app) } } label: {
                Text("Refresh Now")
                    .font(.subheadline.weight(.semibold))
                    .frame(minHeight: 44)
            }
            .accessibilityLabel("Refresh \(app.name)")
            .buttonStyle(.borderless)
            .disabled(companion.loading || app.busy || companion.connectionIssue != nil)
        }
    }
}

struct SideRelayUpdateSettings: View {
    @EnvironmentObject private var companion: SideRelayConnection

    var body: some View {
        Section {
            Toggle("Update LiveContainer Automatically", isOn: Binding(
                get: { companion.status?.autoUpdate ?? false },
                set: { value in Task { await companion.setAutoUpdate(value) } }
            ))
            .disabled(companion.status == nil || companion.loading || companion.connectionIssue != nil)
            if let expiry = companion.status?.companionExpiry {
                HStack {
                    Text("Signature Expires")
                    Spacer()
                    Text(SideRelayConnection.formatDate(expiry)).foregroundStyle(SideRelayConnection.expiryColor(expiry))
                }
            }
            if let update = companion.status?.updateMessage, companion.status?.autoUpdate == true {
                Text(update).foregroundStyle(.secondary)
            }
            if let error = companion.settingsError ?? companion.connectionIssue {
                Text(error).foregroundStyle(.secondary)
                if companion.connectionIssue != nil {
                    Button("Check Connection") { Task { await companion.load() } }.disabled(companion.loading)
                }
            }
        } header: {
            Text("SideRelay")
        } footer: {
            Text("Your Mac installs new releases when it can reach this iPhone.")
        }
        .task { await companion.load() }
    }
}

struct SideRelayAbout: View {
    var body: some View {
        Section("About") {
            Link(destination: URL(string: "https://github.com/LiveContainer/LiveContainer")!) {
                HStack {
                    Text("LiveContainer")
                    Spacer()
                    Text(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")
                        .foregroundStyle(.secondary)
                }
            }
            Link("SideRelay on GitHub", destination: URL(string: "https://github.com/arkemys-consulting/SideRelay")!)
        }
    }
}

extension View {
    @ViewBuilder
    func sideRelaySettingsNavigationBar(visible: Bool) -> some View {
        if #available(iOS 16.0, *) {
            toolbar(visible ? .visible : .hidden, for: .navigationBar)
        } else {
            navigationBarHidden(!visible)
        }
    }
}

struct SideRelayVersionFooter: View {
    var enableDeveloperSettings: () -> Void

    var body: some View {
        if let version = Bundle.main.object(forInfoDictionaryKey: "SideRelayVersion") as? String,
           !version.isEmpty {
            Text("SideRelay \(version)")
                .font(.footnote)
                .onTapGesture(count: 5, perform: enableDeveloperSettings)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
        }
    }
}

@MainActor
final class SideRelayConnection: ObservableObject {
    @Published private(set) var status: DeviceStatus?
    @Published private(set) var connectionIssue: String?
    @Published private(set) var refreshMessage: String?
    @Published private(set) var settingsError: String?
    @Published private(set) var loading = false
    private let installedIcons = NSCache<NSString, UIImage>()

    func installedAppIcon(_ app: ManagedApp) async -> UIImage? {
        let key = app.iconLoadKey as NSString
        if let icon = installedIcons.object(forKey: key) { return icon }
        struct Artwork: Decodable { let png: Data? }
        guard UUID(uuidString: app.id) != nil,
              let artwork: Artwork = try? await request(path: "apps/\(app.id)/icon"),
              let data = artwork.png, data.count <= 128 * 1024,
              let icon = UIImage(data: data) else { return nil }
        installedIcons.setObject(icon, forKey: key)
        return icon
    }

    static func formatDate(_ expiry: Double) -> String {
        Date(timeIntervalSince1970: expiry).formatted(
            Date.FormatStyle(date: .abbreviated, time: .omitted, locale: Locale(identifier: "en"))
        )
    }

    static func expiryText(_ expiry: Double?) -> String {
        guard let expiry else { return "Expiration unavailable" }
        return expiry <= Date().timeIntervalSince1970
            ? "Expired \(formatDate(expiry))" : "Expires \(formatDate(expiry))"
    }

    static func expiryColor(_ expiry: Double) -> Color {
        let remaining = expiry - Date().timeIntervalSince1970
        return remaining <= 86_400 ? .red : remaining <= 3 * 86_400 ? .orange : .green
    }

    func load() async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        do {
            status = try await request(path: "status")
            connectionIssue = nil
            settingsError = nil
        } catch is CancellationError {
        } catch let error as URLError where error.code == .cancelled {
        } catch {
            connectionIssue = connectionMessage(error)
        }
    }

    func setAutoUpdate(_ enabled: Bool) async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let body = try JSONEncoder().encode(["enabled": enabled])
            status = try await request(path: "auto-update", body: body)
            connectionIssue = nil
            settingsError = nil
        } catch {
            settingsError = "Could not save this setting on the Mac."
        }
    }

    func refresh(_ app: ManagedApp) async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let body = try JSONEncoder().encode(["appID": app.id])
            let response: DeviceStatus = try await request(path: "refresh", body: body)
            status = response
            connectionIssue = nil
            guard let job = response.refreshJobID, UUID(uuidString: job) != nil else {
                refreshMessage = "An operation is already in progress for \(app.name)."
                return
            }
            refreshMessage = "Refreshing \(app.name)…"
            for _ in 0..<30 {
                try await Task.sleep(nanoseconds: 2_000_000_000)
                let result: RefreshJob = try await request(path: "jobs/\(job)")
                switch result.status {
                case "done", "failed", "cancelled", "canceled":
                    if result.status == "done" { refreshMessage = "\(app.name) refreshed." }
                    else if result.status == "failed" {
                        switch result.errorCode {
                        case "pairing-unreachable": refreshMessage = "The Mac couldn’t reach this iPhone’s installation service. Try USB or Wi-Fi."
                        case "apple-account": refreshMessage = "Reconnect the Apple Account in SideRelay on the Mac."
                        case "certificate-limit": refreshMessage = "The Apple certificate limit was reached. Review certificates on the Mac."
                        default: refreshMessage = "Could not refresh \(app.name). See Activity on the Mac."
                        }
                    } else { refreshMessage = "The refresh was cancelled." }
                    if let latest: DeviceStatus = try? await request(path: "status") { status = latest }
                    return
                default: break
                }
            }
            refreshMessage = "The Mac is still working. Pull down to check again."
        } catch ConnectionError.unavailable {
            refreshMessage = "The Mac could not queue this refresh. Check Activity on the Mac."
        } catch {
            refreshMessage = "Could not confirm the refresh. Check Activity on the Mac."
        }
    }

    private func connectionMessage(_ error: Error) -> String {
        switch error as? ConnectionError {
        case .notConfigured:
            return "Install SideRelay from the Mac to connect this iPhone."
        case .denied:
            return "The Mac did not recognize this iPhone. Connect to the same Tailscale account and check Devices on the Mac."
        default:
            return "Could not reach the Mac. Keep SideRelay running on the Mac and connect both devices to Tailscale."
        }
    }

    struct HomeScreenApp: Encodable {
        let name: String
        let bundle: String
        let folder: String?
        let installedAt: TimeInterval?
        let icon: Data?
    }

    enum HomeScreenProfileState: String, Decodable {
        case current, outdated, installed, missing, unknown
    }

    func homeScreenProfileState(apps: [HomeScreenApp]) async throws -> HomeScreenProfileState {
        struct Profile: Decodable { let state: HomeScreenProfileState }
        let body = try JSONEncoder().encode(["apps": apps])
        let profile: Profile = try await request(path: "home-screen/status", body: body)
        return profile.state
    }

    func prepareHomeScreenShortcuts(apps: [HomeScreenApp], restoring: Bool) async throws -> URL {
        struct Selection: Encodable {
            let apps: [HomeScreenApp]
            let restore: Bool
        }
        struct Download: Decodable {
            let token: String
        }
        let body = try JSONEncoder().encode(Selection(apps: apps, restore: restoring))
        let download: Download = try await request(path: "home-screen", body: body)
        guard download.token.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else {
            throw URLError(.badServerResponse)
        }
        return try networkConfiguration().base
            .appendingPathComponent("home-screen")
            .appendingPathComponent(download.token)
            .appendingPathComponent("SideRelay.mobileconfig")
    }

    private func networkConfiguration() throws -> (base: URL, deviceID: String) {
        let config = Bundle.main.object(forInfoDictionaryKey: "SideRelayConnection") as? [String: String]
        guard let endpoint = config?["address"], let deviceID = config?["deviceID"],
              let base = URL(string: endpoint), base.scheme == "https", base.port == 19445,
              let host = base.host, host.hasSuffix(".ts.net"), base.user == nil, base.password == nil else {
            throw ConnectionError.notConfigured
        }
        return (base, deviceID)
    }

    private func request<Result: Decodable>(path: String, body: Data? = nil) async throws -> Result {
        let (base, deviceID) = try networkConfiguration()
        var request = URLRequest(url: base.appendingPathComponent(path), timeoutInterval: 15)
        request.setValue(deviceID, forHTTPHeaderField: "X-SideRelay-Device")
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.url == request.url else {
            throw URLError(.badServerResponse)
        }
        if http.statusCode == 403 { throw ConnectionError.denied }
        if http.statusCode == 409 { throw ConnectionError.unavailable }
        guard http.statusCode == 200 else { throw URLError(.badServerResponse) }
        return try JSONDecoder().decode(Result.self, from: data)
    }

    private enum ConnectionError: Error {
        case notConfigured, denied, unavailable
    }

    private struct RefreshJob: Decodable {
        let status: String
        let errorCode: String?
    }
}

struct DeviceStatus: Decodable {
    let apps: [ManagedApp]
    let autoUpdate: Bool?
    let updateMessage: String?
    let refreshJobID: String?

    var companionExpiry: Double? {
        apps.first { $0.bundleID == Bundle.main.bundleIdentifier }?.expiresAt
    }

    var installedApps: [ManagedApp] {
        apps.filter { $0.bundleID != Bundle.main.bundleIdentifier }
    }
}

struct ManagedApp: Decodable, Identifiable {
    let id: String
    let name: String
    let bundleID: String
    let version: String?
    let expiresAt: Double?
    let canRefresh: Bool
    let busy: Bool
    let state: String?
    let iconRevision: Int?

    var iconLoadKey: String { "\(id):\(version ?? ""):\(iconRevision ?? 0)" }
}
