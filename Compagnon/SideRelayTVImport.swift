import Foundation

extension TVLibrary {
    private struct PairedImport: Decodable {
        let bundleID: String
        let build: String
    }

    func importPairedIPA(_ url: URL) {
        guard url.scheme == "tvcontainer", url.host == "siderelay-import",
              url.query == nil, url.fragment == nil,
              let request = UUID(uuidString: url.lastPathComponent),
              url.path == "/\(request.uuidString.lowercased())",
              let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
        else { return }

        let id = request.uuidString.lowercased()
        let stem = caches.appendingPathComponent("SideRelayImport-\(id)")
        let manifest = stem.appendingPathExtension("request")
        let archive = stem.appendingPathExtension("ipa")
        guard let data = try? Data(contentsOf: manifest), data.count <= 4096,
              let payload = try? JSONDecoder().decode(PairedImport.self, from: data),
              FileManager.default.fileExists(atPath: archive.path)
        else { return }

        // Only a paired file transfer can supply an archive. The URL carries a request ID.
        do { try FileManager.default.removeItem(at: manifest) }
        catch { return }

        func finish(_ failure: String? = nil) {
            var result: [String: Any] = ["request": id, "bundleID": payload.bundleID]
            if let failure {
                result["error"] = failure
            } else {
                result["installed"] = true
            }
            if let receipt = try? JSONSerialization.data(withJSONObject: result) {
                try? receipt.write(to: stem.appendingPathExtension("json"), options: .atomic)
            }
            try? FileManager.default.removeItem(at: archive)
        }

        guard !busy else { finish("TVContainer is already working. Try again when it finishes."); return }
        let directory = TVInstaller.applicationsURL()
        let guests = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        for guest in guests where guest.pathExtension == "app" {
            let info = NSDictionary(contentsOf: guest.appendingPathComponent("LCAppInfo.plist"))
            guard info?["LCOrignalBundleIdentifier"] as? String == payload.bundleID else { continue }
            let metadata = NSDictionary(contentsOf: guest.appendingPathComponent("Info.plist"))
            if let build = metadata?["CFBundleVersion"], String(describing: build) == payload.build {
                finish()
            } else {
                finish("Another build of this app is already in TVContainer.")
            }
            return
        }

        guard TVInstaller.hasCertificate() else {
            finish("Set up the SideRelay companion’s signing identity first.")
            return
        }
        busy = true
        error = nil
        status = "Installing from SideRelay…"
        TVInstaller.installArchive(archive) { failure in
            Task { @MainActor in
                self.busy = false
                if let failure {
                    self.error = failure.localizedDescription
                    self.status = ""
                    finish(failure.localizedDescription)
                } else {
                    self.reload()
                    self.status = "App installed. Open Apps to launch it."
                    finish()
                }
            }
        }
    }
}
