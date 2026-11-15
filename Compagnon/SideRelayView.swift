import Foundation
import Security
import SwiftUI
import UniformTypeIdentifiers

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

    func installedAppIcon(_ app: ManagedApp, television: String? = nil) async -> UIImage? {
        let key = app.iconLoadKey as NSString
        if let icon = installedIcons.object(forKey: key) { return icon }
        struct Artwork: Decodable { let png: Data? }
        guard UUID(uuidString: app.id) != nil else { return nil }
        let prefix = television.map { "apple-tv/\($0)/" } ?? ""
        guard let artwork: Artwork = try? await request(path: "\(prefix)apps/\(app.id)/icon"),
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
        let icon: Data
    }

    func prepareHomeScreenApp(_ app: HomeScreenApp) async throws -> URL {
        struct Launcher: Decodable { let id: String }
        let body = try JSONEncoder().encode(app)
        let launcher: Launcher = try await request(path: "home-screen/launch", body: body)
        guard launcher.id.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
            throw URLError(.badServerResponse)
        }
        return try networkConfiguration().base
            .appendingPathComponent("home-screen/launch")
            .appendingPathComponent(launcher.id, isDirectory: true)
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

    fileprivate func request<Result: Decodable>(path: String, body: Data? = nil, file: URL? = nil,
                                                 progress: (@Sendable (Int64, Int64) -> Void)? = nil) async throws -> Result {
        let (base, deviceID) = try networkConfiguration()
        var request = URLRequest(url: base.appendingPathComponent(path), timeoutInterval: file == nil ? 15 : 300)
        request.setValue(deviceID, forHTTPHeaderField: "X-SideRelay-Device")
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        let delegate = SideRelayTVTransfer(progress: progress)
        let (data, response): (Data, URLResponse)
        if let file {
            request.httpMethod = "POST"
            request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
            (data, response) = try await URLSession.shared.upload(for: request, fromFile: file, delegate: delegate)
        } else {
            (data, response) = try await URLSession.shared.data(for: request, delegate: delegate)
        }
        guard let http = response as? HTTPURLResponse, http.url == request.url else {
            throw URLError(.badServerResponse)
        }
        if http.statusCode == 403 { throw ConnectionError.denied }
        if [400, 409].contains(http.statusCode), path.hasSuffix("/ipa/install"),
           let failure = try? JSONDecoder().decode([String: String].self, from: data), let message = failure["error"] {
            throw SideRelayTVInstallError(message: message)
        }
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

struct SideRelayAppleTV: Decodable, Identifiable {
    let id: String
    let name: String
}

private struct SideRelayTVInstallError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

private final class SideRelayTVTransfer: NSObject, URLSessionTaskDelegate {
    let progress: (@Sendable (Int64, Int64) -> Void)?

    init(progress: (@Sendable (Int64, Int64) -> Void)?) { self.progress = progress }

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
                    totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        progress?(totalBytesSent, totalBytesExpectedToSend)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest) async -> URLRequest? { nil }
}

struct SideRelayAppleTVView: View {
    @EnvironmentObject private var companion: SideRelayConnection
    @State private var deviceID: String
    @State private var apps: [ManagedApp]?
    @State private var importing = false
    @State private var working = false
    @State private var message: String?
    @State private var transfer: (sent: Int64, total: Int64)?
    @State private var jobProgress: Int?
    let devices: [SideRelayAppleTV]
    let query: String

    init(devices: [SideRelayAppleTV], query: String) {
        self.devices = devices
        self.query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        _deviceID = State(initialValue: devices.first?.id ?? "")
    }

    private var matchingApps: [ManagedApp] {
        (apps ?? []).filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) }
    }

    var body: some View {
        List {
            Section {
                if devices.count > 1 {
                    Picker("Apple TV", selection: $deviceID) {
                        ForEach(devices) { Text($0.name).tag($0.id) }
                    }
                    .disabled(working)
                }
                Button("Install IPA from Files…", systemImage: "square.and.arrow.up") { importing = true }
                    .disabled(working || apps == nil)
                if let transfer, transfer.total > 0 {
                    ProgressView(value: Double(transfer.sent), total: Double(transfer.total)) {
                        Text("\(transfer.sent.formatted(.byteCount(style: .file))) of \(transfer.total.formatted(.byteCount(style: .file)))")
                    }
                    .accessibilityLabel("Uploading to the Mac")
                } else if working {
                    if let jobProgress {
                        ProgressView(value: Double(jobProgress), total: 100)
                            .accessibilityLabel("Installation progress")
                    } else {
                        ProgressView().accessibilityLabel("Waiting for SideRelay on the Mac")
                    }
                }
                if let message { Text(message).foregroundStyle(.secondary) }
            }
            Section("Installed Apps") {
                if apps == nil && message == nil { ProgressView("Loading installed apps…") }
                if let apps, apps.isEmpty { Text("No apps managed by SideRelay.").foregroundStyle(.secondary) }
                if let apps, !apps.isEmpty && matchingApps.isEmpty {
                    Text("No matching apps.").foregroundStyle(.secondary)
                }
                ForEach(matchingApps) { app in
                    HStack {
                        SideRelayAppleTVArtwork(app: app, device: deviceID)
                        VStack(alignment: .leading) {
                            Text(app.name).font(.headline)
                            Text(SideRelayConnection.expiryText(app.expiresAt)).font(.footnote).foregroundStyle(.secondary)
                            if let state = app.state { Text(state).font(.footnote).foregroundStyle(.secondary) }
                        }
                        Spacer()
                        Button("Refresh", systemImage: "arrow.clockwise") { Task { await refresh(app) } }
                            .labelStyle(.iconOnly)
                            .accessibilityLabel("Refresh \(app.name)")
                            .disabled(working || !app.canRefresh || app.busy)
                    }
                }
            }
        }
        .task(id: deviceID) {
            apps = nil
            message = nil
            await loadApps(for: deviceID)
        }
        .refreshable { if !working { await loadApps(for: deviceID) } }
        .fileImporter(isPresented: $importing, allowedContentTypes: [UTType(filenameExtension: "ipa") ?? .data]) { result in
            switch result {
            case .success(let file): Task { await install(file) }
            case .failure: message = "Could not open this IPA in Files."
            }
        }
    }

    private func loadApps(for device: String) async {
        do {
            let status: DeviceStatus = try await companion.request(path: "apple-tv/\(device)/status")
            if device == deviceID, !Task.isCancelled { apps = status.apps }
        } catch is CancellationError {
        } catch {
            if device == deviceID, !Task.isCancelled { message = "Could not load this Apple TV. Check SideRelay on the Mac." }
        }
    }

    private func install(_ file: URL) async {
        guard !working, UUID(uuidString: deviceID) != nil else { return }
        let granted = file.startAccessingSecurityScopedResource()
        defer { if granted { file.stopAccessingSecurityScopedResource() } }
        guard file.pathExtension.lowercased() == "ipa",
              let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize,
              (4...512 * 1024 * 1024).contains(size) else {
            message = "Choose an IPA smaller than 512 MB."
            return
        }
        working = true
        let device = deviceID
        transfer = (0, Int64(size))
        message = "Uploading to the Mac…"
        defer { working = false; transfer = nil; jobProgress = nil }
        do {
            let result: InstallReceipt = try await companion.request(path: "apple-tv/\(device)/ipa/install", file: file) { sent, total in
                Task { @MainActor in
                    if transfer != nil { transfer = (min(sent, Int64(size)), total > 0 ? total : Int64(size)) }
                }
            }
            transfer = nil
            await follow(result.jobID, on: device, success: "App installed.")
        } catch let error as SideRelayTVInstallError {
            message = error.message
        } catch {
            message = "Could not confirm the installation. Check Activity on the Mac before retrying."
        }
    }

    private func refresh(_ app: ManagedApp) async {
        guard !working else { return }
        working = true
        message = "Refreshing \(app.name)…"
        defer { working = false; jobProgress = nil }
        let device = deviceID
        do {
            let body = try JSONEncoder().encode(["appID": app.id])
            let status: DeviceStatus = try await companion.request(path: "apple-tv/\(device)/refresh", body: body)
            apps = status.apps
            guard let job = status.refreshJobID else { message = "A refresh is already in progress."; return }
            await follow(job, on: device, success: "\(app.name) refreshed.")
        } catch {
            message = "Could not confirm the refresh. Check Activity on the Mac."
        }
    }

    private func follow(_ job: String, on device: String, success: String) async {
        guard UUID(uuidString: job) != nil else { message = "Check Activity on the Mac for the result."; return }
        message = "Working on the Mac…"
        do {
            for _ in 0..<60 {
                let state: InstallProgress = try await companion.request(path: "apple-tv/\(device)/jobs/\(job)")
                if ["done", "failed", "cancelled", "canceled"].contains(state.status) {
                    jobProgress = nil
                    message = state.status == "done" ? success : "This operation did not finish. See Activity on the Mac."
                    await loadApps(for: device)
                    return
                }
                jobProgress = state.progress.flatMap { (1...100).contains($0) ? $0 : nil }
                if state.stage == "installing" { message = "Installing on Apple TV…" }
                try await Task.sleep(nanoseconds: 2_000_000_000)
            }
        } catch {}
        message = "Check Activity on the Mac for the result."
    }

    private struct InstallReceipt: Decodable { let jobID: String }
    private struct InstallProgress: Decodable { let status: String; let progress: Int?; let stage: String? }
}

private struct SideRelayAppleTVArtwork: View {
    @EnvironmentObject private var companion: SideRelayConnection
    @State private var image: UIImage?
    let app: ManagedApp
    let device: String

    var body: some View {
        Group {
            if let image { Image(uiImage: image).resizable().scaledToFit() }
            else { Image(systemName: "app.fill").foregroundStyle(.secondary) }
        }
        .frame(width: 42, height: 36)
        .accessibilityHidden(true)
        .task(id: app.iconLoadKey) { image = await companion.installedAppIcon(app, television: device) }
    }
}

struct DeviceStatus: Decodable {
    var appleTVs: [SideRelayAppleTV]?
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
