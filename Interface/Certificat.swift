import Foundation

func ecrireCertificat(_ donnees: Data, dans destination: URL) throws {
    let fichiers = FileManager.default
    let provisoire = try fichiers.url(for: .itemReplacementDirectory, in: .userDomainMask,
                                      appropriateFor: destination, create: true)
    defer { try? fichiers.removeItem(at: provisoire) }

    let fichier = provisoire.appendingPathComponent("LiveContainer.p12")
    guard fichiers.createFile(atPath: fichier.path, contents: donnees,
                              attributes: [.posixPermissions: 0o600]) else {
        throw CocoaError(.fileWriteUnknown)
    }

    if fichiers.fileExists(atPath: destination.path) {
        _ = try fichiers.replaceItemAt(destination, withItemAt: fichier, backupItemName: nil,
                                       options: [.usingNewMetadataOnly])
    } else {
        try fichiers.moveItem(at: fichier, to: destination)
    }
}
