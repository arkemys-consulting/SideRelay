import AppKit
import CryptoKit
import SwiftUI
import UniformTypeIdentifiers

struct ExtensionIPA: Codable, Identifiable {
    var id: String { path }
    let path: String
    let name: String
    let identifier: String?
    var presetID: String { identifier ?? path.split(separator: "/").suffix(2).joined(separator: "/") }
}

struct InformationsIPA: Codable {
    let name: String
    let identifier: String
    let minimum: String
    let platform: String
    let extensions: [ExtensionIPA]
}

struct AppareilXcode: Codable, Identifiable {
    let id: String
    let name: String
    let platform: String
    let udid: String
}

struct ApplicationDebug: Decodable, Identifiable {
    let id: String
    let name: String
}

private struct CibleSignature: Decodable, Identifiable {
    let id: String
    let name: String
}

private struct CiblesSignature: Decodable {
    let devices: [CibleSignature]
    let deviceUDIDs: [String: String]?
    let accounts: [CibleSignature]
}

private struct PresetIPA: Codable {
    let name: String
    let identifier: String
    let minimum: String
    let sharing: Bool
    let removed: [String]
    let removeDeviceModels: Bool
    let icon: String?
}

private struct ResultatAtelier: Decodable {
    let log: String?
    let safeLog: String?
    let error: String?
    let devices: [AppareilXcode]?
    let apps: [ApplicationDebug]?
}

struct ControleProvisionnement: Decodable {
    struct Composant: Decodable, Identifiable {
        var id: String { bundle }
        let bundle: String
        let profile: String?
        let expires: String?
        let errors: [String]
        let warnings: [String]
    }

    let ready: Bool
    let components: [Composant]
}

@MainActor
final class AtelierIPA: ObservableObject {
    @Published var source: URL?
    @Published var info: InformationsIPA?
    @Published var nom = ""
    @Published var identifiant = ""
    @Published var version = ""
    @Published var partage = false
    @Published var icone: URL?
    @Published var retirer: Set<String> = []
    @Published var retirerModeles = false
    @Published var composants: [URL] = []
    @Published var lien = ""
    @Published var saisieLien = false
    @Published var onglet = "package"
    @Published var mode = "export"
    @Published var certificatImporte: URL?
    @Published var profilsImportes: [URL] = []
    @Published var motDePasseCertificat = ""
    @Published var controleProfils: ControleProvisionnement?

    var peutSignerAvecProfils: Bool {
        certificatImporte != nil && !profilsImportes.isEmpty && !chargeCibles &&
            cibles?.deviceUDIDs?[appareilSignature]?.isEmpty == false
    }
    @Published var occupé = false
    @Published var message = ""
    @Published var succes: URL?
    @Published var appareils: [AppareilXcode] = []
    @Published private var cibles: CiblesSignature?
    @Published var appareilSignature = ""
    @Published var compteSignature = ""
    @Published private(set) var chargeCibles = false
    @Published private(set) var erreurCibles = false
    @Published private(set) var presetCharge = false
    fileprivate var appareilsSignature: [CibleSignature] { cibles?.devices ?? [] }
    fileprivate var comptesSignature: [CibleSignature] { cibles?.accounts ?? [] }
    @Published var appareil = ""
    @Published var appareilJIT = ""
    @Published var applicationJIT = ""
    @Published private(set) var applicationsJIT: [ApplicationDebug] = []
    @Published private(set) var rechercheAppareils = false
    @Published private(set) var erreurAppareils = false
    @Published var log = ""
    @Published private(set) var journalEnCours = false
    @Published private(set) var messageJournal = "No log entries."
    @Published var masquer = UserDefaults.standard.bool(forKey: "sideRelayPrivate")
    @Published var captureActive = false

    let runtime: SideRelayRuntime
    var racine: URL { runtime.source }
    private let script = Bundle.main.resourceURL!.appendingPathComponent("ArchiveIPA.py")
    private var capture: Process?
    private var flux: Task<Void, Never>?
    private var lectureJournal: Task<Void, Never>?
    private var titreLog = "Installation Logs"
    private var journalPrive = ""
    private var installationLocale = ""
    private var installationPrivee = ""
    var changementConfidentialite: ((Bool) -> Void)?

    init(runtime: SideRelayRuntime) { self.runtime = runtime }

    private var temporaire: URL {
        if runtime.python != nil { return runtime.data }
        return racine.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("tmp/Travaux", isDirectory: true)
    }

    private nonisolated static func executer(_ runtime: SideRelayRuntime, _ script: URL, _ arguments: [String], entree: Data? = nil) throws -> Data {
        let processus = Process()
        let sortie = Pipe()
        runtime.configure(processus, [script.path] + arguments)
        processus.standardOutput = sortie
        processus.standardError = FileHandle.nullDevice
        let canal = entree.map { _ in Pipe() }
        if let canal {
            processus.standardInput = canal
        } else {
            processus.standardInput = FileHandle.nullDevice
        }
        try processus.run()
        if let canal, let entree {
            do {
                try canal.fileHandleForWriting.write(contentsOf: entree)
                try canal.fileHandleForWriting.close()
            } catch {
                try? canal.fileHandleForWriting.close()
            }
        }
        let data = sortie.fileHandleForReading.readDataToEndOfFile()
        processus.waitUntilExit()
        if processus.terminationStatus != 0 {
            let detail = (try? JSONDecoder().decode(ResultatAtelier.self, from: data))?.error
            throw ErreurAtelier(message: detail ?? "SideRelay could not complete the operation.")
        }
        return data
    }

    private func commande(_ arguments: [String], entree: Data? = nil) async throws -> Data {
        let script = self.script
        let runtime = self.runtime
        let params = arguments + ["--scratch", temporaire.path]
        return try await Task.detached(priority: .userInitiated) { try Self.executer(runtime, script, params, entree: entree) }.value
    }

    private func travail(_ action: @escaping @MainActor () async throws -> Void) {
        guard !occupé else { return }
        occupé = true
        message = ""
        Task {
            defer { occupé = false }
            do { try await action() }
            catch { message = error.localizedDescription }
        }
    }

    func ouvrirIPA() {
        let panneau = NSOpenPanel()
        panneau.allowedContentTypes = [UTType(filenameExtension: "ipa") ?? .data]
        panneau.allowsMultipleSelection = false
        if panneau.runModal() == .OK, let url = panneau.url { importer(url) }
    }

    func importer(_ url: URL, profils: Bool = false) {
        guard !occupé else { return }
        guard url.isFileURL, url.pathExtension.lowercased() == "ipa" else {
            message = "Choose an .ipa file."
            return
        }
        travail {
            let data = try await self.commande(["inspect", url.path])
            try self.charger(data, depuis: url)
            if profils, self.info?.platform == "iPhoneOS" {
                self.mode = "imported"
                self.chargerCibles()
            }
        }
    }

    private func charger(_ data: Data, depuis url: URL) throws {
        info = try JSONDecoder().decode(InformationsIPA.self, from: data)
        source = url
        certificatImporte = nil
        profilsImportes = []
        motDePasseCertificat = ""
        controleProfils = nil
        nom = ""
        identifiant = ""
        version = ""
        partage = false
        icone = nil
        retirer = []
        retirerModeles = false
        composants = []
        succes = nil
        onglet = "package"
        mode = "export"
        presetCharge = false
        chargerPreset()
    }

    private var dossierPreset: URL? {
        guard let info, !info.identifier.isEmpty else { return nil }
        let hash = SHA256.hash(data: Data("\(info.platform):\(info.identifier)".utf8))
            .map { String(format: "%02x", $0) }.joined()
        return runtime.data.appendingPathComponent("atelier-presets/\(hash)", isDirectory: true)
    }

    private func chargerPreset() {
        guard let dossier = dossierPreset, let info,
              let donnees = try? Data(contentsOf: dossier.appendingPathComponent("preset.json")),
              let preset = try? JSONDecoder().decode(PresetIPA.self, from: donnees) else { return }
        nom = preset.name
        identifiant = preset.identifier
        version = preset.minimum
        partage = preset.sharing
        retirerModeles = preset.removeDeviceModels
        retirer = Set(info.extensions.filter { preset.removed.contains($0.presetID) }.map(\.path))
        if let fichier = preset.icon,
           fichier.range(of: "^icon-[0-9a-f]{64}\\.(png|jpg|jpeg)$", options: .regularExpression) != nil {
            let url = dossier.appendingPathComponent(fichier)
            if FileManager.default.isReadableFile(atPath: url.path) { icone = url }
        }
        presetCharge = true
    }

    func enregistrerPreset() {
        guard let dossier = dossierPreset, let info else { return }
        do {
            let fm = FileManager.default
            try fm.createDirectory(at: dossier, withIntermediateDirectories: true,
                                   attributes: [.posixPermissions: 0o700])
            var fichier: String?
            if let icone {
                let ext = icone.pathExtension.lowercased()
                guard ["png", "jpg", "jpeg"].contains(ext),
                      let taille = try icone.resourceValues(forKeys: [.fileSizeKey]).fileSize,
                      taille <= 16 * 1024 * 1024 else {
                    throw ErreurAtelier(message: "Choose a PNG or JPEG icon smaller than 16 MB.")
                }
                let data = try Data(contentsOf: icone)
                let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
                let nom = "icon-\(hash).\(ext)"
                try data.write(to: dossier.appendingPathComponent(nom), options: .atomic)
                fichier = nom
            }
            let preset = PresetIPA(name: nom, identifier: identifiant, minimum: version, sharing: partage,
                                   removed: info.extensions.filter { retirer.contains($0.path) }.map(\.presetID).sorted(),
                                   removeDeviceModels: retirerModeles, icon: fichier)
            try JSONEncoder().encode(preset).write(to: dossier.appendingPathComponent("preset.json"), options: .atomic)
            for ancien in try fm.contentsOfDirectory(at: dossier, includingPropertiesForKeys: nil)
                where ancien.lastPathComponent.hasPrefix("icon-") && ancien.lastPathComponent != fichier {
                try? fm.removeItem(at: ancien)
            }
            if let fichier { icone = dossier.appendingPathComponent(fichier) }
            presetCharge = true
            message = "Preset saved for this app."
        } catch {
            message = "Could not save the preset: \(error.localizedDescription)"
        }
    }

    func supprimerPreset() {
        guard let dossier = dossierPreset, presetCharge else { return }
        let iconeStockee = icone?.deletingLastPathComponent() == dossier
        do {
            try FileManager.default.removeItem(at: dossier)
            if iconeStockee { icone = nil }
            presetCharge = false
            message = "Saved preset removed."
        } catch { message = "Could not remove the preset: \(error.localizedDescription)" }
    }

    func chargerCibles() {
        guard !chargeCibles else { return }
        chargeCibles = true
        erreurCibles = false
        let runtime = self.runtime
        let script = runtime.launcher
        Task {
            defer { chargeCibles = false }
            do {
                let data = try await Task.detached(priority: .userInitiated) {
                    try Self.executer(runtime, script, ["cibles-signature"])
                }.value
                let resultat = try JSONDecoder().decode(CiblesSignature.self, from: data)
                cibles = resultat
                if !resultat.devices.contains(where: { $0.id == appareilSignature }) {
                    appareilSignature = resultat.devices.count == 1 ? (resultat.devices.first?.id ?? "") : ""
                }
                if !resultat.accounts.contains(where: { $0.id == compteSignature }) {
                    compteSignature = resultat.accounts.count == 1 ? (resultat.accounts.first?.id ?? "") : ""
                }
            } catch {
                cibles = nil
                appareilSignature = ""
                compteSignature = ""
                erreurCibles = true
            }
        }
    }

    func choisirIcone() {
        let panneau = NSOpenPanel()
        panneau.allowedContentTypes = [.png, .jpeg]
        if panneau.runModal() == .OK { icone = panneau.url }
    }

    func choisirComposants() {
        let panneau = NSOpenPanel()
        let extensions = ["dylib", "framework", "bundle", "deb"]
        panneau.allowedContentTypes = extensions.compactMap { UTType(filenameExtension: $0) }
        panneau.allowsMultipleSelection = true
        panneau.canChooseDirectories = true
        guard panneau.runModal() == .OK else { return }
        let selection = panneau.urls.filter { extensions.contains($0.pathExtension.lowercased()) }
        guard !selection.isEmpty else {
            message = "Choose an iOS dylib, framework, resource bundle or Debian package."
            return
        }
        composants.append(contentsOf: selection.filter { !composants.contains($0) })
    }

    func proposerLien(_ url: URL) -> Bool {
        guard !occupé, url.scheme?.lowercased() == "siderelay", url.host == "import",
              let composants = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let items = composants.queryItems, items.count == 1, items[0].name == "url",
              let texte = items[0].value, texte.count <= 4096,
              let source = URL(string: texte), source.scheme == "https", source.host != nil
        else { return false }
        lien = texte
        onglet = "package"
        saisieLien = true
        return true
    }

    func telecharger() {
        let texte = lien.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !occupé, let url = URL(string: texte), url.scheme == "https", url.host != nil else {
            message = "Enter an HTTPS link to an IPA."
            return
        }
        let nom = url.pathExtension.lowercased() == "ipa" ? url.lastPathComponent : "Download.ipa"
        guard let dest = destination(nom) else { return }
        saisieLien = false
        travail {
            let data = try await self.commande(["download", texte, dest.path])
            try self.charger(data, depuis: dest)
            self.message = "IPA downloaded."
        }
    }

    private func destination(_ nom: String) -> URL? {
        let panneau = NSSavePanel()
        panneau.allowedContentTypes = [UTType(filenameExtension: "ipa") ?? .data]
        panneau.nameFieldStringValue = nom
        panneau.directoryURL = source?.deletingLastPathComponent() ?? racine
        return panneau.runModal() == .OK ? panneau.url : nil
    }

    func choisirProfilOuCertificat(profils: Bool) {
        let panneau = NSOpenPanel()
        let extensionFichier = profils ? "mobileprovision" : "p12"
        panneau.allowedContentTypes = [UTType(filenameExtension: extensionFichier) ?? .data]
        panneau.allowsMultipleSelection = profils
        guard panneau.runModal() == .OK else { return }
        let fichiers = panneau.urls.filter { $0.pathExtension.lowercased() == extensionFichier }
        guard fichiers.count == panneau.urls.count else {
            message = "Choose a .\(extensionFichier) file."
            return
        }
        if profils {
            profilsImportes = fichiers
        } else {
            certificatImporte = fichiers.first
            motDePasseCertificat = ""
        }
        controleProfils = nil
        message = ""
    }

    func verifierInstallation() {
        guard let source, let udid = appareils.first(where: { $0.id == appareil })?.udid, !udid.isEmpty else {
            message = "Choose a paired device with a registered identifier."
            return
        }
        controleProfils = nil
        travail {
            let options = String(decoding: try JSONEncoder().encode(["udid": udid]), as: UTF8.self)
            let data = try await self.commande(["preflight", source.path, "--options", options])
            self.controleProfils = try JSONDecoder().decode(ControleProvisionnement.self, from: data)
        }
    }

    func verifierProfils(exporter: Bool) {
        guard let source, peutSignerAvecProfils, let certificatImporte,
              let udid = cibles?.deviceUDIDs?[appareilSignature] else { return }
        let password = Data(motDePasseCertificat.utf8)
        guard password.count <= 4096 else {
            message = "The certificate password is too long."
            return
        }
        let dest = exporter ? destination(source.deletingPathExtension().lastPathComponent + "-signed.ipa") : nil
        if exporter && dest == nil { return }
        let profils = profilsImportes.map(\.path)
        controleProfils = nil
        if exporter { succes = nil }
        travail {
            let options = try JSONSerialization.data(withJSONObject: [
                "udid": udid, "certificate": certificatImporte.path, "profiles": profils,
            ])
            let json = String(decoding: options, as: UTF8.self)
            var arguments = [exporter ? "sign-imported" : "check-imported", source.path]
            if let dest { arguments.append(dest.path) }
            let data = try await self.commande(arguments + ["--options", json], entree: password)
            let rapport = try JSONDecoder().decode(ControleProvisionnement.self, from: data)
            if rapport.ready, let dest {
                self.motDePasseCertificat = ""
                self.succes = dest
                self.message = "Signed IPA exported for the selected device."
            }
            self.controleProfils = rapport
        }
    }

    func appliquer() {
        guard let source, !occupé else { return }
        if mode == "imported" {
            verifierProfils(exporter: true)
            return
        }
        if mode == "mac" {
            travail {
                _ = try await self.commande(["mac-package", source.path])
                let installateur = URL(fileURLWithPath: "/System/Library/CoreServices/Applications/iOS App Installer.app")
                _ = try await NSWorkspace.shared.open([source], withApplicationAt: installateur,
                                                      configuration: NSWorkspace.OpenConfiguration())
                self.message = "Complete the installation in iOS App Installer."
            }
            return
        }
        if mode == "install" {
            guard !appareil.isEmpty else { return }
            let selection = appareil
            if let paquet = info?.platform, let cible = appareils.first(where: { $0.id == selection }),
               (paquet == "AppleTVOS") != (cible.platform == "tvOS") {
                message = "Choose an IPA built for the selected device’s platform."
                return
            }
            let confirmation = NSAlert()
            confirmation.messageText = "Install this signed IPA?"
            confirmation.informativeText = "Xcode will install the selected package on the paired device."
            confirmation.addButton(withTitle: "Install")
            confirmation.addButton(withTitle: "Cancel")
            guard confirmation.runModal() == .alertFirstButtonReturn else { return }
            travail {
                do {
                    let data = try await self.commande(["install", source.path, selection])
                    self.installationLocale = try JSONDecoder().decode(ResultatAtelier.self, from: data).log ?? ""
                    self.installationPrivee = "Install signed IPA · Succeeded"
                    self.message = "App installed."
                } catch {
                    self.installationLocale = error.localizedDescription
                    self.installationPrivee = "Install signed IPA · Failed"
                    throw error
                }
            }
            return
        }
        if mode == "signed", (appareilSignature.isEmpty || compteSignature.isEmpty) { return }
        let suffixe = mode == "signed" ? "-signed.ipa" : mode == "adhoc" ? "-ad-hoc.ipa" : "-prepared.ipa"
        guard let dest = destination(source.deletingPathExtension().lastPathComponent + suffixe) else { return }
        guard dest.standardizedFileURL.resolvingSymlinksInPath() != source.standardizedFileURL.resolvingSymlinksInPath() else {
            message = "Choose a destination other than the original IPA."
            return
        }
        let mode = self.mode
        let cible = appareilSignature
        let compte = compteSignature
        let options = OptionsIPA(name: nom, identifier: identifiant, minimum: version,
                                 sharing: partage, icon: icone?.path, remove: retirer.sorted(),
                                 removeDeviceModels: retirerModeles, components: composants.map(\.path))
        travail {
            let json = String(decoding: try JSONEncoder().encode(options), as: UTF8.self)
            if mode == "signed" {
                let dossier = self.temporaire.appendingPathComponent("siderelay-export-\(UUID().uuidString)", isDirectory: true)
                try FileManager.default.createDirectory(at: dossier, withIntermediateDirectories: false,
                                                        attributes: [.posixPermissions: 0o700])
                defer { try? FileManager.default.removeItem(at: dossier) }
                let pret = dossier.appendingPathComponent("prepared.ipa")
                _ = try await self.commande(["export", source.path, pret.path, "--options", json])
                var request = URLRequest(url: URL(string: "http://127.0.0.1:18784/api/siderelay/export-ipa")!,
                                         timeoutInterval: 300)
                request.httpMethod = "POST"
                request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
                request.setValue(cible, forHTTPHeaderField: "X-SideRelay-Device")
                request.setValue(compte, forHTTPHeaderField: "X-SideRelay-Account")
                let configuration = URLSessionConfiguration.ephemeral
                configuration.timeoutIntervalForResource = 900
                let session = URLSession(configuration: configuration)
                defer { session.finishTasksAndInvalidate() }
                let (data, response) = try await session.upload(for: request, fromFile: pret)
                guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                      http.mimeType == "application/octet-stream", data.starts(with: [0x50, 0x4B, 0x03, 0x04]) else {
                    let detail = (response as? HTTPURLResponse)?.statusCode == 422
                        ? String(data: data.prefix(600), encoding: .utf8) : nil
                    throw ErreurAtelier(message: detail ?? "SideRelay could not sign this IPA. Check that its service is running.")
                }
                try data.write(to: dest, options: .atomic)
                self.message = "Signed IPA exported for the selected device."
            } else {
                _ = try await self.commande([mode, source.path, dest.path, "--options", json])
                self.message = mode == "adhoc" ? "IPA exported." : "IPA exported. Open it in Install IPA to sign with your Apple Account."
            }
            self.succes = dest
        }
    }

    func actualiserAppareils() {
        guard !rechercheAppareils else { return }
        rechercheAppareils = true
        erreurAppareils = false
        Task {
            defer { rechercheAppareils = false }
            do {
                let data = try await commande(["devices", racine.path])
                let liste = try JSONDecoder().decode(ResultatAtelier.self, from: data).devices ?? []
                appareils = liste
                if !liste.contains(where: { $0.id == appareil }) { appareil = liste.first?.id ?? "" }
                if !appareilsJIT.contains(where: { $0.id == appareilJIT }) { appareilJIT = appareilsJIT.first?.id ?? "" }
            } catch {
                erreurAppareils = true
            }
        }
    }

    var appareilsJIT: [AppareilXcode] { appareils.filter { $0.platform != "tvOS" } }

    func viderApplicationsJIT() {
        applicationsJIT = []
        applicationJIT = ""
    }

    func chercherApplicationsJIT() {
        guard !occupé, !appareilJIT.isEmpty else { return }
        let cible = appareilJIT
        viderApplicationsJIT()
        travail {
            let data = try await self.commande(["debug-apps", cible])
            let apps = try JSONDecoder().decode(ResultatAtelier.self, from: data).apps ?? []
            guard self.appareilJIT == cible else { return }
            self.applicationsJIT = apps
            self.applicationJIT = apps.first?.id ?? ""
            if apps.isEmpty { self.message = "Xcode found no development apps on this device." }
        }
    }

    func activerJIT() {
        guard applicationsJIT.contains(where: { $0.id == applicationJIT }), !appareilJIT.isEmpty else { return }
        let cible = appareilJIT
        let application = applicationJIT
        travail {
            let data = try await self.commande(["jit", cible, application])
            self.message = try JSONDecoder().decode(ResultatAtelier.self, from: data).log ?? ""
        }
    }

    func lireJournal(jobID: String? = nil) {
        onglet = "logs"
        arreterCapture()
        titreLog = "Installation Logs"
        lectureJournal?.cancel()
        log = ""
        journalPrive = ""
        journalEnCours = true
        messageJournal = jobID == nil ? "No log entries." : "This installation log is no longer available."
        var arguments = ["jobs", runtime.data.appendingPathComponent("signature.db").path]
        if let jobID { arguments += ["--job", jobID] }
        lectureJournal = Task {
            defer { if !Task.isCancelled { journalEnCours = false } }
            do {
                let data = try await commande(arguments)
                guard !Task.isCancelled else { return }
                let resultat = try JSONDecoder().decode(ResultatAtelier.self, from: data)
                log = [jobID == nil ? installationLocale : "", resultat.log ?? ""]
                    .filter { !$0.isEmpty }.joined(separator: "\n\n")
                journalPrive = [jobID == nil ? installationPrivee : "", resultat.safeLog ?? ""]
                    .filter { !$0.isEmpty }.joined(separator: "\n")
            } catch {
                if !Task.isCancelled { messageJournal = "Could not load installation logs." }
            }
        }
    }

    func ouvrirConsole() {
        NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: "/System/Applications/Utilities/Console.app"),
                                            configuration: NSWorkspace.OpenConfiguration())
    }

    func demarrerCapture() {
        guard capture == nil, let cible = appareils.first(where: { $0.id == appareil }),
              !cible.udid.isEmpty else {
            message = "Select an iPhone paired with this Mac."
            return
        }
        guard let outil = ["/opt/homebrew/bin/idevicesyslog", "/usr/local/bin/idevicesyslog"]
            .first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            message = "Live capture requires idevicesyslog. Open Console to view the device logs."
            return
        }
        let p = Process()
        let sortie = Pipe()
        p.executableURL = URL(fileURLWithPath: outil)
        p.arguments = ["-u", cible.udid]
        p.standardOutput = sortie
        p.standardError = sortie
        do { try p.run() }
        catch { message = error.localizedDescription; return }
        capture = p
        captureActive = true
        titreLog = "Device Logs"
        log = ""
        journalPrive = "Device log capture. Raw entries are hidden in privacy mode."
        message = ""
        let lecture = sortie.fileHandleForReading
        flux = Task.detached(priority: .utility) { [weak self] in
            while !Task.isCancelled, let data = try? lecture.read(upToCount: 8192), !data.isEmpty {
                await self?.ajouterJournal(String(decoding: data, as: UTF8.self))
            }
            await self?.terminerCapture(p)
        }
    }

    private func terminerCapture(_ p: Process) {
        if capture === p {
            capture = nil
            captureActive = false
            flux = nil
        }
    }

    private func ajouterJournal(_ fragment: String) {
        log += fragment
        if log.count > 80_000 { log = String(log.suffix(60_000)) }
    }

    func arreterCapture() {
        flux?.cancel()
        if capture?.isRunning == true { capture?.terminate() }
        capture = nil
        captureActive = false
        flux = nil
    }

    func basculerConfidentialite() {
        masquer.toggle()
        UserDefaults.standard.set(masquer, forKey: "sideRelayPrivate")
        changementConfidentialite?(masquer)
    }

    func proteger(_ texte: String) -> String {
        // Share a structural summary so arbitrary text from an app or device cannot disclose personal data.
        masquer && !texte.isEmpty ? "Details hidden while privacy mode is on." : texte
    }

    var journalAffiche: String { masquer ? journalPrive : log }

    func enregistrerJournal() {
        let panneau = NSSavePanel()
        panneau.allowedContentTypes = [.plainText]
        panneau.nameFieldStringValue = titreLog.replacingOccurrences(of: " ", with: "-") + ".txt"
        guard panneau.runModal() == .OK, let url = panneau.url else { return }
        do { try journalAffiche.write(to: url, atomically: true, encoding: .utf8) }
        catch { message = error.localizedDescription }
    }
}

private struct OptionsIPA: Encodable {
    let name: String
    let identifier: String
    let minimum: String
    let sharing: Bool
    let icon: String?
    let remove: [String]
    let removeDeviceModels: Bool
    let components: [String]
}

private struct ErreurAtelier: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

struct VueAtelierIPA: View {
    @ObservedObject var atelier: AtelierIPA
    @State private var survole = false

    var body: some View {
        VStack(spacing: 0) {
            TabView(selection: $atelier.onglet) {
                paquet.tabItem { Label("IPA Workshop", systemImage: "shippingbox") }.tag("package")
                jit.tabItem { Label("JIT", systemImage: "bolt") }.tag("jit")
                journaux.tabItem { Label("Logs", systemImage: "list.bullet.rectangle") }.tag("logs")
            }
            if !atelier.message.isEmpty || atelier.occupé || atelier.succes != nil {
                Divider()
                HStack(spacing: 10) {
                    if atelier.occupé { ProgressView().controlSize(.small) }
                    Text(atelier.occupé ? "Working…" : atelier.proteger(atelier.message))
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                        .textSelection(.enabled)
                    Spacer()
                    if let url = atelier.succes {
                        Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([url]) }
                    }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 10)
            }
        }
        .padding(12)
        .frame(minWidth: 550, minHeight: 430)
        .sheet(isPresented: $atelier.saisieLien) { feuilleLien }
        .onDrop(of: [.fileURL], isTargeted: $survole) { elements in
            guard !atelier.occupé, elements.count == 1, let element = elements.first else { return false }
            element.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
                let url = (item as? URL) ?? (item as? Data).flatMap { URL(dataRepresentation: $0, relativeTo: nil) }
                if let url {
                    Task { @MainActor in atelier.importer(url) }
                }
            }
            return true
        }
    }

    private var paquet: some View {
        VStack(spacing: 0) {
            if let info = atelier.info {
                Form {
                    Section("Package") {
                        LabeledContent("App", value: atelier.masquer ? "Hidden" : info.name)
                        LabeledContent("Platform", value: info.platform.isEmpty ? "Unknown" : info.platform)
                    }
                    Section("Action") {
                        Picker("Mode", selection: $atelier.mode) {
                            Text("Prepare IPA").tag("export")
                            if info.platform == "iPhoneOS" {
                                Text("Export Signed IPA").tag("signed")
                                Text("Sign with Imported Profiles").tag("imported")
                            }
                            Text("Export with Ad Hoc Signature").tag("adhoc")
                            Text("Install Signed IPA").tag("install")
                            if info.platform == "iPhoneOS" { Text("Install on This Mac").tag("mac") }
                        }
                        if atelier.mode == "install" {
                            appareils
                            if info.platform == "iPhoneOS" {
                                Button("Check Installation") { atelier.verifierInstallation() }
                                    .disabled(atelier.appareil.isEmpty)
                            }
                        } else if atelier.mode == "imported" {
                            appareilSignature
                            signatureImportee
                        } else if atelier.mode == "signed" {
                            ciblesSignature
                            Text("Uses the saved Apple signing identity for the selected device. Nothing is installed.")
                                .foregroundStyle(.secondary)
                        } else if atelier.mode == "mac" {
                            Text("Choose an IPA signed in Xcode with this Apple Silicon Mac in its provisioning profile.")
                                .foregroundStyle(.secondary)
                        } else if atelier.mode == "adhoc" {
                            Text("Local signature for testing and export. A device still needs a valid provisioning profile.")
                                .foregroundStyle(.secondary)
                        }
                    }
                    if let rapport = atelier.controleProfils {
                        Section("Profile Check") {
                            Text(rapport.ready ? "Profile checks passed for this device." : "Profile checks found issues.")
                                .fontWeight(.medium)
                            ForEach(rapport.components) { composant in
                                VStack(alignment: .leading, spacing: 5) {
                                    if !atelier.masquer {
                                        Text(composant.bundle).fontWeight(.medium)
                                        if let profile = composant.profile { Text(profile).foregroundStyle(.secondary) }
                                        if let date = composant.expires.flatMap({ ISO8601DateFormatter().date(from: $0) }) {
                                            Text("Expires \(date.formatted(date: .abbreviated, time: .shortened))")
                                                .foregroundStyle(.secondary)
                                        }
                                    }
                                    ForEach(composant.errors, id: \.self) { detail in
                                        Label(atelier.proteger(detail), systemImage: "xmark.circle").foregroundStyle(.red)
                                    }
                                    ForEach(composant.warnings, id: \.self) { detail in
                                        Label(atelier.proteger(detail), systemImage: "exclamationmark.triangle")
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                .textSelection(.enabled)
                            }
                        }
                    }
                    if ["export", "adhoc", "signed"].contains(atelier.mode) {
                        Section("Customize") {
                            if atelier.masquer {
                                SecureField("App Name", text: $atelier.nom)
                                SecureField("Bundle ID", text: $atelier.identifiant)
                            } else {
                                TextField("App Name", text: $atelier.nom, prompt: Text(info.name))
                                TextField("Bundle ID", text: $atelier.identifiant, prompt: Text(info.identifier))
                            }
                            TextField("Minimum OS", text: $atelier.version, prompt: Text(info.minimum))
                            Text("Changing the minimum version in the package does not change what the executable supports.")
                                .foregroundStyle(.secondary)
                            HStack {
                                Text("App Icon")
                                Spacer()
                                if let icone = atelier.icone {
                                    Text(atelier.masquer ? "Hidden" : icone.lastPathComponent.hasPrefix("icon-") ? "Custom icon" : icone.lastPathComponent)
                                        .foregroundStyle(.secondary).lineLimit(1)
                                    Button("Reset") { atelier.icone = nil }.buttonStyle(.borderless)
                                }
                                Button("Choose Image…") { atelier.choisirIcone() }
                                    .disabled(info.platform == "AppleTVOS")
                            }
                            Toggle("Share Documents in Files and Finder", isOn: $atelier.partage)
                                .disabled(info.platform == "AppleTVOS")
                            Toggle("Remove Device Model Limits", isOn: $atelier.retirerModeles)
                            if atelier.retirerModeles {
                                Text("The app still needs the hardware it was built to use.").foregroundStyle(.secondary)
                            }
                        }
                        if !info.identifier.isEmpty {
                            Section("Preset") {
                                LabeledContent("For This App") {
                                    HStack {
                                        if atelier.presetCharge {
                                            Button("Remove Preset", role: .destructive) { atelier.supprimerPreset() }
                                        }
                                        Button(atelier.presetCharge ? "Update Preset" : "Save Preset") {
                                            atelier.enregistrerPreset()
                                        }
                                    }
                                }
                            }
                        }
                        if info.platform == "iPhoneOS" { composants }
                        if !info.extensions.isEmpty {
                            Section {
                                ForEach(Array(info.extensions.enumerated()), id: \.element.id) { index, item in
                                    Toggle(atelier.masquer ? "Extension \(index + 1)" : item.name, isOn: Binding(
                                        get: { atelier.retirer.contains(item.path) },
                                        set: { if $0 { atelier.retirer.insert(item.path) } else { atelier.retirer.remove(item.path) } }))
                                }
                            } header: {
                                HStack {
                                    Text("Remove Extensions")
                                    Spacer()
                                    Button(atelier.retirer.count == info.extensions.count ? "Clear" : "Select All") {
                                        atelier.retirer = atelier.retirer.count == info.extensions.count
                                            ? [] : Set(info.extensions.map(\.path))
                                    }
                                    .buttonStyle(.borderless)
                                }
                            }
                        }
                    }
                }
                .formStyle(.grouped)
                .disabled(atelier.occupé)
                .onChange(of: atelier.mode) {
                    atelier.controleProfils = nil
                    if atelier.mode == "install" { atelier.actualiserAppareils() }
                    if ["signed", "imported"].contains(atelier.mode) { atelier.chargerCibles() }
                    if atelier.mode != "imported" { atelier.motDePasseCertificat = "" }
                }
                .onChange(of: atelier.appareil) { atelier.controleProfils = nil }
                .onChange(of: atelier.appareilSignature) { atelier.controleProfils = nil }
            } else {
                ContentUnavailableView {
                    Label("Open an IPA", systemImage: "shippingbox")
                } description: {
                    Text("Drop a file here or choose one to inspect, customize or install.")
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background {
                    if survole {
                        RoundedRectangle(cornerRadius: 10).strokeBorder(Color.accentColor, lineWidth: 2)
                    }
                }
            }
            Divider()
            HStack(spacing: 8) {
                Button("Choose IPA…") { atelier.ouvrirIPA() }
                Button("Open Link…") { atelier.saisieLien = true }
                Spacer()
                if atelier.info != nil {
                    Button(atelier.mode == "install" || atelier.mode == "mac" ? "Install…" : "Export…") { atelier.appliquer() }
                        .keyboardShortcut(.defaultAction)
                        .disabled((atelier.mode == "install" && atelier.appareil.isEmpty) ||
                                  (atelier.mode == "signed" && (atelier.chargeCibles ||
                                   atelier.appareilSignature.isEmpty || atelier.compteSignature.isEmpty)) ||
                                  (atelier.mode == "imported" && !atelier.peutSignerAvecProfils))
                }
            }
            .padding(12)
            .disabled(atelier.occupé)
        }
    }

    private var composants: some View {
        Section("Tweaks") {
            ForEach(Array(atelier.composants.enumerated()), id: \.element) { index, url in
                HStack {
                    Text(atelier.masquer ? "Component \(index + 1)" : url.lastPathComponent)
                        .lineLimit(1)
                    Spacer()
                    Button("Remove") { atelier.composants.removeAll { $0 == url } }
                        .buttonStyle(.borderless)
                }
            }
            Button("Add Components…") { atelier.choisirComposants() }
            Text("Add iOS libraries, frameworks, resource bundles or Debian packages before signing.")
                .foregroundStyle(.secondary)
        }
    }

    private var jit: some View {
        Form {
            Section("Development App") {
                Picker("Device", selection: $atelier.appareilJIT) {
                    if atelier.appareilsJIT.isEmpty {
                        Text(atelier.rechercheAppareils ? "Searching for devices…" : "No paired iPhone or iPad").tag("")
                    }
                    ForEach(Array(atelier.appareilsJIT.enumerated()), id: \.element.id) { index, device in
                        Text(atelier.masquer ? "Device \(index + 1)" : device.name).tag(device.id)
                    }
                }
                HStack {
                    Button("Refresh Devices") { atelier.actualiserAppareils() }.disabled(atelier.rechercheAppareils)
                    Button("Find Apps") { atelier.chercherApplicationsJIT() }.disabled(atelier.appareilJIT.isEmpty)
                }
                if !atelier.applicationsJIT.isEmpty {
                    Picker("App", selection: $atelier.applicationJIT) {
                        ForEach(Array(atelier.applicationsJIT.enumerated()), id: \.element.id) { index, app in
                            Text(atelier.masquer ? "App \(index + 1)" : app.name).tag(app.id)
                        }
                    }
                    Button("Enable JIT") { atelier.activerJIT() }.disabled(atelier.applicationJIT.isEmpty)
                }
                Text("Connect and unlock the device with Developer Mode on. For an app already open on the device, SideRelay uses that session.")
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .disabled(atelier.occupé)
        .onAppear { if atelier.appareilsJIT.isEmpty { atelier.actualiserAppareils() } }
        .onChange(of: atelier.appareilJIT) { atelier.viderApplicationsJIT() }
    }

    private var appareilSignature: some View {
        Picker("Device", selection: $atelier.appareilSignature) {
            Text(atelier.appareilsSignature.isEmpty ? "No registered devices" : "Choose a device").tag("")
            ForEach(Array(atelier.appareilsSignature.enumerated()), id: \.element.id) { index, cible in
                Text(atelier.masquer ? "Device \(index + 1)" : cible.name).tag(cible.id)
            }
        }
    }

    private var signatureImportee: some View {
        Group {
            LabeledContent("Certificate (.p12)") {
                Button(atelier.certificatImporte.map { atelier.masquer ? "Change Certificate…" : $0.lastPathComponent } ?? "Choose…") {
                    atelier.choisirProfilOuCertificat(profils: false)
                }
                .lineLimit(1)
            }
            if atelier.certificatImporte != nil {
                SecureField("Certificate Password", text: $atelier.motDePasseCertificat)
                    .onChange(of: atelier.motDePasseCertificat) {
                        if atelier.succes == nil { atelier.controleProfils = nil }
                    }
            }
            LabeledContent("Provisioning Profiles") {
                Button(atelier.profilsImportes.isEmpty ? "Choose…" : "Change \(atelier.profilsImportes.count) Profile(s)…") {
                    atelier.choisirProfilOuCertificat(profils: true)
                }
            }
            if !atelier.profilsImportes.isEmpty && !atelier.masquer {
                Text(atelier.profilsImportes.map(\.lastPathComponent).joined(separator: ", "))
                    .foregroundStyle(.secondary)
            }
            if atelier.chargeCibles {
                ProgressView().controlSize(.small)
            } else if atelier.erreurCibles {
                Button("Reload Devices") { atelier.chargerCibles() }
            }
            Button("Check Profiles") { atelier.verifierProfils(exporter: false) }
                .disabled(!atelier.peutSignerAvecProfils)
        }
    }

    private var ciblesSignature: some View {
        Group {
            appareilSignature
            Picker("Apple Account", selection: $atelier.compteSignature) {
                Text(atelier.comptesSignature.isEmpty ? "No saved accounts" : "Choose an account").tag("")
                ForEach(Array(atelier.comptesSignature.enumerated()), id: \.element.id) { index, cible in
                    Text(atelier.masquer ? "Account \(index + 1)" : cible.name).tag(cible.id)
                }
            }
            if atelier.chargeCibles {
                ProgressView().controlSize(.small)
            } else if atelier.erreurCibles {
                Button("Reload Devices and Accounts") { atelier.chargerCibles() }
            }
        }
    }

    private var appareils: some View {
        HStack {
            Picker("Device", selection: $atelier.appareil) {
                if atelier.appareils.isEmpty {
                    if atelier.rechercheAppareils {
                        Text("Searching for devices…").tag("")
                    } else if atelier.erreurAppareils {
                        Text("Could not list devices").tag("")
                    } else {
                        Text("No paired devices").tag("")
                    }
                }
                ForEach(Array(atelier.appareils.enumerated()), id: \.element.id) { index, appareil in
                    Text(atelier.masquer ? "\(appareil.platform) \(index + 1)" : appareil.name).tag(appareil.id)
                }
            }
            Button("Refresh") { atelier.actualiserAppareils() }
                .disabled(atelier.rechercheAppareils)
            if atelier.erreurAppareils, !atelier.appareils.isEmpty {
                Text("Could not refresh devices.")
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var journaux: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Button("All Installation Logs") { atelier.lireJournal() }.disabled(atelier.journalEnCours)
                Spacer()
                Toggle("Hide Personal Information", isOn: Binding(get: { atelier.masquer },
                            set: { if $0 != atelier.masquer { atelier.basculerConfidentialite() } }))
            }
            appareils
            HStack {
                Button(atelier.captureActive ? "Stop Capture" : "Capture Device Logs") {
                    if atelier.captureActive { atelier.arreterCapture() } else { atelier.demarrerCapture() }
                }
                .disabled(atelier.journalEnCours)
                Button("Open Console") { atelier.ouvrirConsole() }
                Spacer()
                Button("Export Log…") { atelier.enregistrerJournal() }.disabled(atelier.log.isEmpty)
            }
            ScrollView {
                if atelier.journalEnCours {
                    ProgressView("Loading installation log…").padding(10)
                } else {
                    Text(atelier.journalAffiche.isEmpty ? atelier.messageJournal : atelier.journalAffiche)
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(10)
                }
            }
            .background(.background, in: RoundedRectangle(cornerRadius: 8))
        }
        .padding(14)
        .onAppear {
            if atelier.log.isEmpty, !atelier.journalEnCours { atelier.lireJournal() }
            if atelier.appareils.isEmpty { atelier.actualiserAppareils() }
        }
    }

    private var feuilleLien: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Download an IPA").font(.headline)
            if atelier.masquer {
                SecureField("HTTPS URL", text: $atelier.lien)
            } else {
                TextField("HTTPS URL", text: $atelier.lien, prompt: Text("https://…"))
            }
            if let host = URL(string: atelier.lien)?.host {
                LabeledContent("Host", value: atelier.masquer ? "Hidden" : host)
                    .foregroundStyle(.secondary)
            }
            HStack {
                Spacer()
                Button("Cancel") { atelier.saisieLien = false }.keyboardShortcut(.cancelAction)
                Button("Download…") { atelier.telecharger() }.keyboardShortcut(.defaultAction)
                    .disabled(!atelier.lien.hasPrefix("https://"))
            }
        }
        .padding(20)
        .frame(width: 430)
    }
}
