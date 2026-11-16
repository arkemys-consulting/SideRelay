import AppKit
import CommonCrypto
import CryptoKit
import Foundation
import UniformTypeIdentifiers

enum PortableBackup {
    private static let magic = Data("SideRelayBackup1".utf8)
    private static let saltSize = 16
    private static let frameSize = 4 * 1024 * 1024
    private static let sealOverhead = 28

    enum Failure: LocalizedError {
        case invalid, password, output

        var errorDescription: String? {
            switch self {
            case .invalid: "This file is incomplete or is not a SideRelay backup."
            case .password: "The password is incorrect or the backup is damaged."
            case .output: "SideRelay could not save the backup."
            }
        }
    }

    private static func deriveKey(_ password: String, salt: Data) throws -> SymmetricKey {
        var bytes = [UInt8](repeating: 0, count: 32)
        let length = bytes.count
        let result = salt.withUnsafeBytes { saltBytes in
            password.withCString { passphrase in
                CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), passphrase, password.utf8.count,
                    saltBytes.baseAddress!.assumingMemoryBound(to: UInt8.self), salt.count,
                    CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), 600_000, &bytes, length)
            }
        }
        guard result == kCCSuccess else { throw Failure.password }
        return SymmetricKey(data: bytes)
    }

    private static func authenticatedData(_ header: Data, _ frame: UInt64) -> Data {
        withUnsafeBytes(of: frame.bigEndian) { header + Data($0) }
    }

    private static func output(at url: URL) throws -> FileHandle {
        let descriptor = open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { throw Failure.output }
        return FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    }

    static func encrypt(from source: URL, to destination: URL, password: String) throws {
        let salt = SymmetricKey(size: .bits128).withUnsafeBytes { Data($0) }
        let header = magic + salt
        let key = try deriveKey(password, salt: salt)
        let temporary = destination.deletingLastPathComponent().appendingPathComponent(".siderelay-\(UUID().uuidString).partial")
        let input = try FileHandle(forReadingFrom: source)
        let file = try output(at: temporary)
        defer { try? FileManager.default.removeItem(at: temporary) }
        try file.write(contentsOf: header)
        var frame: UInt64 = 0
        while true {
            let bytes = try input.read(upToCount: frameSize) ?? Data()
            let seal = try AES.GCM.seal(bytes, using: key, authenticating: authenticatedData(header, frame))
            guard let combined = seal.combined else { throw Failure.output }
            let size = withUnsafeBytes(of: UInt32(combined.count).bigEndian) { Data($0) }
            try file.write(contentsOf: size)
            try file.write(contentsOf: combined)
            frame += 1
            if bytes.isEmpty { break }
        }
        try file.synchronize()
        try file.close()
        guard rename(temporary.path, destination.path) == 0 else { throw Failure.output }
    }

    static func decrypt(from source: URL, to destination: URL, password: String) throws {
        let input = try FileHandle(forReadingFrom: source)
        guard let header = try input.read(upToCount: magic.count + saltSize),
              header.count == magic.count + saltSize, header.starts(with: magic) else { throw Failure.invalid }
        let key = try deriveKey(password, salt: header.suffix(saltSize))
        let file = try output(at: destination)
        var frame: UInt64 = 0
        while let length = try input.read(upToCount: 4), length.count == 4 {
            let size = length.reduce(0) { ($0 << 8) | Int($1) }
            guard (sealOverhead...frameSize + sealOverhead).contains(size),
                  let data = try input.read(upToCount: size), data.count == size else { throw Failure.invalid }
            let bytes: Data
            do {
                bytes = try AES.GCM.open(AES.GCM.SealedBox(combined: data),
                    using: key, authenticating: authenticatedData(header, frame))
            } catch { throw Failure.password }
            if bytes.isEmpty {
                guard (try input.read(upToCount: 1) ?? Data()).isEmpty else { throw Failure.invalid }
                try file.close()
                return
            }
            try file.write(contentsOf: bytes)
            frame += 1
        }
        throw Failure.invalid
    }
}

struct BackupSummary: Decodable {
    let packages: Int
    let sources: Int
    let missing: Int?
    let restored: Int?
    let failed: Int?
    let pendingRefresh: Int?
    let devicesToPair: [String]?
    let accountsToConnect: [String]?

    var contents: String { "\(packages) IPA builds · \(sources) Store sources" }

    var reconnection: String {
        let devices = devicesToPair ?? []
        let accounts = accountsToConnect ?? []
        var lines: [String] = []
        if !devices.isEmpty { lines.append("Pair again in Devices: " + devices.joined(separator: ", ")) }
        if !accounts.isEmpty { lines.append("Reconnect in Apple Accounts: " + accounts.joined(separator: ", ")) }
        return lines.joined(separator: "\n\n")
    }
}

@MainActor
enum BackupPanels {
    private static let type = UTType(filenameExtension: "siderelaybackup") ?? .data

    static func chooseAction() -> String? {
        let alert = NSAlert()
        alert.messageText = "SideRelay Backup"
        alert.informativeText = "Transfer your IPA library, Store sources, and app refresh settings to another Mac."
        alert.addButton(withTitle: "Export Backup…")
        alert.addButton(withTitle: "Restore Backup…")
        alert.addButton(withTitle: "Cancel")
        switch alert.runModal() {
        case .alertFirstButtonReturn: return "export"
        case .alertSecondButtonReturn: return "restore"
        default: return nil
        }
    }

    static func archiveURL(exporting: Bool) -> URL? {
        let panel: NSSavePanel
        if exporting {
            panel = NSSavePanel()
            panel.nameFieldStringValue = "SideRelay.siderelaybackup"
        } else {
            let open = NSOpenPanel()
            open.canChooseDirectories = false
            panel = open
        }
        panel.allowedContentTypes = [type]
        return panel.runModal() == .OK ? panel.url : nil
    }

    static func password(exporting: Bool) -> String? {
        let prompt = NSAlert()
        prompt.messageText = exporting ? "Encrypt Your Backup" : "Unlock SideRelay Backup"
        prompt.informativeText = exporting
            ? "Choose a password of at least 12 characters. You’ll need it to restore this backup."
            : "Enter the password used to encrypt this backup."
        let password = NSSecureTextField()
        password.placeholderString = "Backup password"
        password.setAccessibilityLabel("Backup password")
        let confirm = NSSecureTextField()
        confirm.placeholderString = "Confirm password"
        confirm.setAccessibilityLabel("Confirm password")
        let fields = [password] + (exporting ? [confirm] : [])
        let stack = NSStackView(views: fields)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.widthAnchor.constraint(equalToConstant: 290).isActive = true
        for field in fields { field.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true }
        prompt.accessoryView = stack
        prompt.window.initialFirstResponder = password
        prompt.addButton(withTitle: exporting ? "Encrypt Backup" : "Unlock")
        prompt.addButton(withTitle: "Cancel")
        while prompt.runModal() == .alertFirstButtonReturn {
            let value = password.stringValue
            if !value.isEmpty && (!exporting || (value.count >= 12 && value == confirm.stringValue)) { return value }
            prompt.informativeText = exporting ? "Enter the same password twice using at least 12 characters."
                : "Enter the backup password."
        }
        return nil
    }

    static func confirmRestore(_ summary: BackupSummary) -> Bool {
        let alert = NSAlert()
        alert.messageText = "Restore SideRelay Backup?"
        alert.informativeText = ([summary.contents, "SideRelay merges the library and sources with this Mac. Matching apps receive the saved Auto-Refresh settings.",
                                  summary.reconnection].filter { !$0.isEmpty }).joined(separator: "\n\n")
        alert.addButton(withTitle: "Restore")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn
    }

    static func restoreComplete(_ summary: BackupSummary) {
        let alert = NSAlert()
        alert.messageText = (summary.failed ?? 0) > 0 ? "Some Builds Couldn’t Be Restored" : "Backup Restored"
        let restored = summary.restored ?? 0
        let failed = summary.failed ?? 0
        let pending = summary.pendingRefresh ?? 0
        var lines = ["\(restored) IPA builds processed · \(summary.sources) Store sources"]
        if failed > 0 { lines.append("\(failed) IPA builds could not be imported. You can retry this backup.") }
        if pending > 0 {
            lines.append("\(pending) Auto-Refresh settings will apply when SideRelay recognises the matching installed apps.")
        }
        lines.append(summary.reconnection)
        alert.informativeText = lines.filter { !$0.isEmpty }.joined(separator: "\n\n")
        alert.runModal()
    }
}
