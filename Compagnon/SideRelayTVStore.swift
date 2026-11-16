import SwiftUI

struct SideRelayTVStoreView: View {
    @State private var apps: [Product] = []
    @State private var loading = false
    @State private var message: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 36) {
                    HStack {
                        Text("Store").font(.largeTitle.bold())
                        Spacer()
                        Button("Refresh", systemImage: "arrow.clockwise") { Task { await load() } }
                            .buttonStyle(.bordered)
                            .disabled(loading)
                    }
                    if apps.isEmpty && !loading && message == nil {
                        ContentUnavailableView("No Apps Available", systemImage: "bag",
                                               description: Text("Check Store sources in SideRelay."))
                    }
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 38), count: 3), spacing: 38) {
                        ForEach(apps) { app in
                            NavigationLink(value: app.id) {
                                HStack(spacing: 20) {
                                    artwork(app.icon, glyph: "app.fill", width: 96, height: 74)
                                    VStack(alignment: .leading, spacing: 6) {
                                        Text(app.name).font(.headline)
                                        Text(app.subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                                        if app.beta { Text("Beta").font(.caption).foregroundStyle(.secondary) }
                                    }
                                    Spacer(minLength: 0)
                                }
                                .frame(maxWidth: .infinity, minHeight: 97, alignment: .leading)
                                .padding(14)
                            }
                            .buttonStyle(.card)
                        }
                    }
                    operationStatus
                }
                .padding(64)
                .frame(maxWidth: 1680)
            }
            .navigationDestination(for: String.self) { id in
                if let app = apps.first(where: { $0.id == id }) { productPage(app) }
                else { ContentUnavailableView("App Unavailable", systemImage: "bag") }
            }
        }
        .task { await load() }
    }

    private var operationStatus: some View {
        VStack(alignment: .leading, spacing: 18) {
            if loading { ProgressView().accessibilityLabel("Contacting SideRelay") }
            if let message { Text(message).foregroundStyle(.secondary) }
        }
    }

    private func productPage(_ app: Product) -> some View {
        ScrollView {
            HStack(alignment: .center, spacing: 60) {
                if let preview = app.preview { artwork(preview, glyph: "tv", width: 790, height: 445) }
                VStack(alignment: .leading, spacing: 20) {
                    artwork(app.icon, glyph: "app.fill", width: 144, height: 105)
                    Text(app.name).font(.largeTitle.bold())
                    Text([app.developer, app.version, app.beta ? "Beta" : nil].compactMap { $0 }.joined(separator: " · "))
                        .foregroundStyle(.secondary)
                    Text(app.description)
                    if let minimum = app.minimumOS, !minimum.isEmpty {
                        Text("Requires tvOS \(minimum) or later").font(.callout).foregroundStyle(.secondary)
                    }
                    if app.action == .installed {
                        Label("Installed", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                    } else if app.action == .unavailable {
                        Text("Manage this app in SideRelay.").foregroundStyle(.secondary)
                    } else {
                        Button(app.action == .update ? "Update" : "Get") { Task { await install(app) } }
                            .buttonStyle(.borderedProminent)
                            .disabled(loading)
                    }
                    operationStatus
                }
                .frame(maxWidth: 700, alignment: .leading)
            }
            .padding(72)
        }
    }

    private func artwork(_ url: URL?, glyph: String, width: CGFloat, height: CGFloat) -> some View {
        AsyncImage(url: url) { image in
            image.resizable().scaledToFill()
        } placeholder: {
            Image(systemName: glyph).font(.title).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity).background(.thinMaterial)
        }
        .frame(width: width, height: height)
        .clipShape(RoundedRectangle(cornerRadius: 20))
        .accessibilityHidden(true)
    }

    @MainActor
    private func load() async {
        guard !loading else { return }
        loading = true
        message = nil
        defer { loading = false }
        do {
            try await readStore()
        } catch is CancellationError {
            return
        } catch {
            message = "Couldn’t load the Store. Check that SideRelay is running and that both devices are connected to Tailscale."
        }
    }

    @MainActor
    private func readStore() async throws {
        let result: Catalogue = try await SideRelayTVAPI.request("store", timeout: 30)
        apps = result.apps
        let receipt = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("SideRelayStoreReady.json")
        try? JSONEncoder().encode(["apps": apps.map(\.name).joined(separator: ", "),
                                    "date": Date().ISO8601Format()]).write(to: receipt, options: .atomic)
    }

    @MainActor
    private func install(_ product: Product) async {
        guard !loading else { return }
        loading = true
        message = "Preparing \(product.name)…"
        defer { loading = false }
        do {
            let payload = try JSONEncoder().encode(["releaseID": product.releaseID])
            let receipt: Install = try await SideRelayTVAPI.request("store/install", payload: payload, timeout: 120)
            guard UUID(uuidString: receipt.jobID) != nil else { throw URLError(.badServerResponse) }
            message = "Installing \(product.name)…"
            for _ in 0..<40 {
                try await Task.sleep(for: .seconds(2))
                let job: Job = try await SideRelayTVAPI.request("jobs/\(receipt.jobID)")
                if ["done", "failed", "cancelled", "canceled"].contains(job.status) {
                    message = job.status == "done" ? "\(product.name) installed." : "Check Activity in SideRelay."
                    try await readStore()
                    return
                }
            }
            message = "SideRelay is still installing \(product.name). Refresh to check again."
        } catch is CancellationError {
            return
        } catch {
            message = "Couldn’t complete the installation. Check Activity in SideRelay."
        }
    }

    private struct Catalogue: Decodable { let apps: [Product] }
    private struct Install: Decodable { let jobID: String }
    private struct Job: Decodable { let status: String }

    private struct Product: Decodable, Identifiable {
        enum Action: String, Decodable { case get, update, installed, unavailable }
        var id: String { bundleID }
        let bundleID: String
        let name: String
        let developer: String
        let subtitle: String
        let description: String
        let icon: URL?
        let preview: URL?
        let beta: Bool
        let minimumOS: String?
        let version: String
        let releaseID: String
        let action: Action
    }
}
