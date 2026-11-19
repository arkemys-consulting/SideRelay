import CryptoKit
import Foundation

struct SideRelayRuntime: Sendable {
    struct MissingComponent: LocalizedError {
        let name: String
        var errorDescription: String? {
            "Missing or unreadable: \(name). Reinstall SideRelay from the complete Mac package."
        }
    }

    let source: URL
    let data: URL
    let engine: URL
    let python: URL?
    let identity: URL
    let usesLegacyDataDirectory: Bool

    init(bundle: Bundle = .main) {
        let resources = bundle.resourceURL!
        let executable = bundle.executableURL!.deletingLastPathComponent()
        let embedded = bundle.object(forInfoDictionaryKey: "SideRelayBundledRuntime") as? Bool == true
        source = (embedded ? resources.appendingPathComponent("Runtime") :
                  bundle.bundleURL.deletingLastPathComponent()).resolvingSymlinksInPath()
        let defaultData = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("SideRelay/donnees", isDirectory: true)
        let configured = UserDefaults.standard.string(forKey: "SideRelayDataDirectory")
        usesLegacyDataDirectory = embedded && configured != nil
        data = embedded ? (configured.map { URL(fileURLWithPath: $0, isDirectory: true) } ?? defaultData)
            : source.appendingPathComponent("donnees")
        engine = embedded ? executable.appendingPathComponent("siderelay-engine") : source.appendingPathComponent("moteur/jas")
        python = embedded ? resources.appendingPathComponent("Python/bin/python3") : nil
        identity = executable.appendingPathComponent("siderelay-identity")
    }

    var launcher: URL { source.appendingPathComponent("signature-ios") }

    func check(resources: URL = Bundle.main.resourceURL!) throws {
        let files = FileManager.default
        if let python, !files.isExecutableFile(atPath: python.path) {
            throw MissingComponent(name: "bundled Python runtime")
        }
        for (file, name) in [(engine, "signing engine"), (identity, "signing identity helper"),
            (identity.deletingLastPathComponent().appendingPathComponent("siderelay-pair"), "USB pairing helper")] {
            if !files.isExecutableFile(atPath: file.path) { throw MissingComponent(name: name) }
        }
        for file in ["App.css", "Guide.js", "Routes.js", "IPA.js", "Outils.js", "Jumelage.js",
                     "Comptes.js", "Bibliotheque.js", "LotsIPA.js", "Store.js", "ArchiveIPA.py"] {
            if !files.isReadableFile(atPath: resources.appendingPathComponent(file).path) {
                throw MissingComponent(name: "SideRelay interface component (\(file))")
            }
        }
        for (file, name) in [("signature-ios", "service launcher"), ("moteur/target/site/pkg/jas.wasm", "signing portal (WebAssembly)"),
            ("moteur/target/site/pkg/jas.js", "signing portal (JavaScript)"),
            ("moteur/target/site/pkg/jas.css", "signing portal (stylesheet)")] {
            if !files.isReadableFile(atPath: source.appendingPathComponent(file).path) {
                throw MissingComponent(name: name)
            }
        }
    }

    func engineToken() throws -> String {
        let key = try Data(contentsOf: data.appendingPathComponent("cle"))
        guard key.count == 64, key.allSatisfy({ (48...57).contains($0) || (65...70).contains($0) || (97...102).contains($0) }) else {
            throw MissingComponent(name: "signing engine credential")
        }
        return HMAC<SHA256>.authenticationCode(for: Data("SideRelay local engine v1".utf8), using: SymmetricKey(data: key))
            .map { String(format: "%02x", $0) }.joined()
    }

    func authorizeEngine(_ request: inout URLRequest) throws {
        request.setValue(try engineToken(), forHTTPHeaderField: "X-SideRelay-Engine")
    }

    func configure(_ process: Process, _ arguments: [String]) {
        process.executableURL = python ?? URL(fileURLWithPath: "/usr/bin/env")
        process.currentDirectoryURL = source
        process.arguments = (python == nil ? ["python3"] : []) + ["-B"] + arguments
        let path = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
        var environment = [
            "PATH": python.map { $0.deletingLastPathComponent().path + ":" + path } ?? path,
            "SIDERELAY_RUNTIME_ROOT": source.path,
            "SIDERELAY_DATA_DIR": data.path,
            "SIDERELAY_ENGINE": engine.path,
            "SIDERELAY_IDENTITY_HELPER": identity.path,
        ]
        if usesLegacyDataDirectory {
            environment["SIDERELAY_LEGACY_LAUNCH_AGENT"] = "1"
        }
        process.environment = environment
    }
}
