import CryptoKit
import Foundation
import Security

private struct ImportError: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

private func check(_ status: OSStatus, _ message: String) throws {
    guard status == errSecSuccess else { throw ImportError(message) }
}

private func fingerprint(_ certificate: SecCertificate) -> String {
    SHA256.hash(data: SecCertificateCopyData(certificate) as Data)
        .map { String(format: "%02X", $0) }.joined()
}

private func verifiedProfile(_ path: String) throws -> Data {
    let encoded = try Data(contentsOf: URL(fileURLWithPath: path))
    let invalid = "The provisioning profile is damaged or is not signed by Apple."
    guard !encoded.isEmpty else { throw ImportError(invalid) }
    var decoder: CMSDecoder?
    try check(CMSDecoderCreate(&decoder), invalid)
    guard let decoder else { throw ImportError(invalid) }
    try check(encoded.withUnsafeBytes { CMSDecoderUpdateMessage(decoder, $0.baseAddress!, $0.count) }, invalid)
    try check(CMSDecoderFinalizeMessage(decoder), invalid)
    var signer = CMSSignerStatus(rawValue: 0)!
    var trust: SecTrust?
    try check(CMSDecoderCopySignerStatus(decoder, 0, SecPolicyCreateBasicX509(), false, &signer, &trust, nil), invalid)
    guard signer == .valid, let trust else { throw ImportError(invalid) }
    SecTrustSetNetworkFetchAllowed(trust, false)
    let appleRoots: Set<String> = [
        "B0B1730ECBC7FF4505142C49F1295E6EDA6BCAED7E2C68C5BE91B5A11001F024",
        "C2B9B042DD57830E7D117DAC55AC8AE19407D38E41D88F3215BC3A890444A050",
        "63343ABFB89A6A03EBB57E9B3F5FA7BE7C4F5C756F3017B3A8C488C3653E9179",
    ]
    guard SecTrustEvaluateWithError(trust, nil),
          let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
          let leaf = chain.first, let root = chain.last, appleRoots.contains(fingerprint(root))
    else { throw ImportError(invalid) }
    var name: CFString?
    guard SecCertificateCopyCommonName(leaf, &name) == errSecSuccess,
          name as String? == "Apple iPhone OS Provisioning Profile Signing"
    else { throw ImportError(invalid) }
    var payload: CFData?
    try check(CMSDecoderCopyContent(decoder, &payload), invalid)
    guard let payload else { throw ImportError(invalid) }
    return payload as Data
}

private func identity(_ path: String, keychainPath: String?) throws -> Data {
    let credentials = FileHandle.standardInput.readDataToEndOfFile()
    guard credentials.count <= 65_536, let password = String(data: credentials, encoding: .utf8) else {
        throw ImportError("Enter the certificate password.")
    }
    let data = try Data(contentsOf: URL(fileURLWithPath: path))
    var options: [String: Any] = [kSecImportExportPassphrase as String: password]
    var keychain: SecKeychain?
    var ready = false
    defer { if !ready, let keychain { SecKeychainDelete(keychain) } }
    if let keychainPath {
        let secret = UUID().uuidString
        try check(secret.withCString { SecKeychainCreate(keychainPath, UInt32(secret.utf8.count), $0, false, nil, &keychain) },
                  "Could not create the temporary signing keychain.")
        guard let keychain else { throw ImportError("The temporary signing keychain is unavailable.") }
        var codesign: SecTrustedApplication?
        try check(SecTrustedApplicationCreateFromPath("/usr/bin/codesign", &codesign),
                  "Could not authorize Apple’s code signing tool.")
        var access: SecAccess?
        guard let codesign else { throw ImportError("Apple’s code signing tool is unavailable.") }
        try check(SecAccessCreate("SideRelay temporary signing key" as CFString, [codesign] as CFArray, &access),
                  "Could not restrict access to the signing key.")
        guard let access else { throw ImportError("Could not restrict access to the signing key.") }
        options[kSecImportExportKeychain as String] = keychain
        options[kSecImportExportAccess as String] = access
    } else {
        options[kSecImportToMemoryOnly as String] = true
    }
    var items: CFArray?
    try check(SecPKCS12Import(data as CFData, options as CFDictionary, &items),
              "Could not open the .p12. Check its password and format.")
    let identities = (items as? [[String: Any]] ?? []).compactMap { $0[kSecImportItemIdentity as String] }
    guard identities.count == 1 else {
        throw ImportError("Choose a .p12 containing one certificate and its private key.")
    }
    let signingIdentity = identities[0] as! SecIdentity
    var certificate: SecCertificate?
    try check(SecIdentityCopyCertificate(signingIdentity, &certificate), "The certificate is missing from the .p12.")
    guard let certificate else { throw ImportError("The certificate is missing from the .p12.") }
    let der = SecCertificateCopyData(certificate) as Data
    ready = true
    return der
}

@main
struct IdentiteImportee {
    static func main() {
        let args = CommandLine.arguments
        do {
            let result: Data
            switch (args.count, args.dropFirst().first) {
            case (3, "profile"): result = try verifiedProfile(args[2])
            case (3, "identity"): result = try identity(args[2], keychainPath: nil)
            case (4, "keychain"): result = try identity(args[2], keychainPath: args[3])
            case (3, "delete-keychain"):
                var keychain: SecKeychain?
                if SecKeychainOpen(args[2], &keychain) == errSecSuccess, let keychain {
                    try check(SecKeychainDelete(keychain), "Could not remove the temporary signing keychain.")
                }
                result = Data()
            default: throw ImportError("Invalid signing tool arguments.")
            }
            FileHandle.standardOutput.write(result)
        } catch {
            FileHandle.standardError.write(Data(error.localizedDescription.utf8))
            exit(EXIT_FAILURE)
        }
    }
}
