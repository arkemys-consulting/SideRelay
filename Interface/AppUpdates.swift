import AppKit
import CryptoKit

struct SideRelayRelease: Sendable {
    private struct Release: Decodable {
        let tagName: String
        let draft: Bool
        let prerelease: Bool
        let assets: [Asset]
    }

    private struct Asset: Decodable {
        let name: String
        let browserDownloadUrl: URL
        let digest: String?
        let size: Int64
    }

    static let repository = "arkemys-consulting/SideRelay"
    private static let releasesURL = URL(string: "https://api.github.com/repos/\(repository)/releases?per_page=12")!
    private static let latestManifestURL = URL(string: "https://github.com/\(repository)/releases/latest/download/siderelay-macos-update.json")!
    private static let downloadHosts = ["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]
    let version: String
    let url: URL
    private let size: Int64
    private let digest: String

    static func latest(after current: String) async throws -> Self? {
        var request = URLRequest(url: releasesURL, timeoutInterval: 15)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        let (data, response) = try await URLSession.shared.data(for: request)
        if (response as? HTTPURLResponse)?.statusCode == 200, response.url == releasesURL {
            return try newer(in: data, after: current)
        }
        // Release downloads remain available when the public API is rate-limited.
        let (manifest, delivery) = try await URLSession.shared.data(for: URLRequest(url: latestManifestURL, timeoutInterval: 15))
        guard isGitHubDownload(delivery) else { throw UpdateError.unavailable }
        return try newer(in: manifest, after: current)
    }

    private static func isGitHubDownload(_ response: URLResponse) -> Bool {
        (response as? HTTPURLResponse)?.statusCode == 200 && response.url?.scheme == "https" &&
            downloadHosts.contains(response.url?.host ?? "")
    }

    static func newer(in data: Data, after current: String) throws -> Self? {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode([Release].self, from: data).compactMap { release -> Self? in
            guard !release.draft, !release.prerelease,
                  release.tagName.range(of: "^v[0-9]+\\.[0-9]+\\.[0-9]+$", options: .regularExpression) != nil else { return nil }
            let version = String(release.tagName.dropFirst())
            guard version.compare(current, options: .numeric) == .orderedDescending else { return nil }
            let filename = "SideRelay-\(version)-macOS-arm64.dmg"
            let url = URL(string: "https://github.com/\(repository)/releases/download/\(release.tagName)/\(filename)")!
            guard let asset = release.assets.first(where: { $0.name == filename && $0.browserDownloadUrl == url }),
                  asset.size > 0, asset.size <= 512 * 1024 * 1024,
                  let digest = asset.digest?.lowercased(),
                  digest.range(of: "^sha256:[0-9a-f]{64}$", options: .regularExpression) != nil else { return nil }
            return Self(version: version, url: url, size: asset.size, digest: String(digest.dropFirst(7)))
        }.max { $0.version.compare($1.version, options: .numeric) == .orderedAscending }
    }

    func download(to directory: URL) async throws -> URL {
        let files = FileManager.default
        try files.createDirectory(at: directory, withIntermediateDirectories: true)
        let destination = directory.appendingPathComponent(url.lastPathComponent)
        if try verified(destination) { return destination }
        let (temporary, response) = try await URLSession.shared.download(from: url)
        defer { try? files.removeItem(at: temporary) }
        guard Self.isGitHubDownload(response) else { throw UpdateError.unavailable }
        guard try verified(temporary) else { throw UpdateError.damaged }
        try Task.checkCancellation()
        if files.fileExists(atPath: destination.path) {
            _ = try files.replaceItemAt(destination, withItemAt: temporary)
        } else {
            try files.moveItem(at: temporary, to: destination)
        }
        return destination
    }

    private func verified(_ file: URL) throws -> Bool {
        guard let values = try? file.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey]),
              values.isRegularFile == true, Int64(values.fileSize ?? -1) == size else { return false }
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        var hash = SHA256()
        while let data = try handle.read(upToCount: 1024 * 1024), !data.isEmpty {
            hash.update(data: data)
        }
        return hash.finalize().map { String(format: "%02x", $0) }.joined() == digest
    }
}

private enum UpdateError: LocalizedError {
    case unavailable, damaged

    var errorDescription: String? {
        switch self {
        case .unavailable: "GitHub could not deliver the update. Try again."
        case .damaged: "The download could not be verified. Try downloading it again."
        }
    }
}

@MainActor
final class SideRelayAppUpdates {
    private weak var window: NSWindow?
    private let current: String
    private let defaults: UserDefaults
    private let stateChanged: (Bool, Bool) -> Void
    private var release: SideRelayRelease?
    private var checks: Task<Void, Never>?
    private var download: Task<Void, Never>?
    private let promptKey = "SideRelayLastOfferedUpdate"

    init(window: NSWindow, current: String, defaults: UserDefaults = .standard, stateChanged: @escaping (Bool, Bool) -> Void) {
        self.window = window
        self.current = current
        self.defaults = defaults
        self.stateChanged = stateChanged
    }

    func start() {
        checks = Task { [weak self, current] in
            while !Task.isCancelled {
                do {
                    let found = try await SideRelayRelease.latest(after: current)
                    guard !Task.isCancelled, let self else { return }
                    self.release = found
                    self.stateChanged(found != nil, self.download != nil)
                    self.offer()
                } catch {
                    // A transient network error leaves the last verified offer available.
                }
                try? await Task.sleep(for: .seconds(6 * 60 * 60))
            }
        }
    }

    func stop() {
        checks?.cancel()
        download?.cancel()
    }

    func offer(fromSidebar: Bool = false) {
        guard let release, let window, window.isVisible, window.attachedSheet == nil, download == nil else { return }
        if !fromSidebar {
            guard window.isKeyWindow, NSApp.isActive, defaults.string(forKey: promptKey) != release.version else { return }
        }
        defaults.set(release.version, forKey: promptKey)
        let alert = NSAlert()
        alert.messageText = "Update SideRelay to \(release.version)?"
        alert.informativeText = "You’re using version \(current). Download and open the new disk image from GitHub?"
        alert.addButton(withTitle: "Yes")
        alert.addButton(withTitle: "No").keyEquivalent = "\u{1b}"
        alert.beginSheetModal(for: window) { [weak self] response in
            if response == .alertFirstButtonReturn { self?.downloadUpdate(release) }
        }
    }

    private func downloadUpdate(_ release: SideRelayRelease) {
        stateChanged(true, true)
        download = Task { [weak self] in
            guard let self else { return }
            defer {
                download = nil
                stateChanged(self.release != nil, false)
            }
            do {
                let cache = try FileManager.default.url(for: .cachesDirectory, in: .userDomainMask,
                                                        appropriateFor: nil, create: true)
                    .appendingPathComponent("SideRelay/Updates", isDirectory: true)
                let file = try await release.download(to: cache)
                try Task.checkCancellation()
                if !NSWorkspace.shared.open(file) { NSWorkspace.shared.activateFileViewerSelecting([file]) }
            } catch is CancellationError {
                return
            } catch {
                guard let window, window.isVisible, window.attachedSheet == nil else { return }
                let alert = NSAlert()
                alert.messageText = "Couldn’t download the update"
                alert.informativeText = error.localizedDescription
                alert.addButton(withTitle: "OK")
                _ = await alert.beginSheetModal(for: window)
            }
        }
    }
}
