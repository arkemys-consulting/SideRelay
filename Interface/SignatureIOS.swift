import AppKit
import CoreImage.CIFilterBuiltins
import CryptoKit
import Darwin
import OSLog
import SwiftUI
import UniformTypeIdentifiers
import UserNotifications
import WebKit

@MainActor
private final class BuildDropWebView: WKWebView {
    var receiveBuild: ((URL) -> Void)?
    var acceptsBuild: (() -> Bool)?

    private func build(in sender: any NSDraggingInfo) -> URL? {
        guard acceptsBuild?() == true,
              let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self],
                  options: [.urlReadingFileURLsOnly: true]) as? [URL],
              urls.count == 1, let url = urls.first, url.pathExtension.lowercased() == "app"
        else { return nil }
        return url
    }

    override func draggingEntered(_ sender: any NSDraggingInfo) -> NSDragOperation {
        build(in: sender) == nil ? super.draggingEntered(sender) : .copy
    }

    override func draggingUpdated(_ sender: any NSDraggingInfo) -> NSDragOperation {
        build(in: sender) == nil ? super.draggingUpdated(sender) : .copy
    }

    override func prepareForDragOperation(_ sender: any NSDraggingInfo) -> Bool {
        build(in: sender) != nil || super.prepareForDragOperation(sender)
    }

    override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
        guard let url = build(in: sender) else { return super.performDragOperation(sender) }
        receiveBuild?(url)
        return true
    }
}

@main
@MainActor
final class SignatureIOS: NSObject, NSApplicationDelegate, NSWindowDelegate, NSMenuDelegate, WKNavigationDelegate, WKUIDelegate {
    private static let port = 18784
    private let journal = Logger(subsystem: "fr.adrien.signature-ios.menu", category: "Portal")
    private let origine = URL(string: "http://127.0.0.1:18784")!
    private let runtime = SideRelayRuntime()
    private var racine: URL { runtime.source }
    private let trousseau = Trousseau(service: "fr.adrien.signature-ios.menu.apple-account")
    private var element: NSStatusItem!
    private var raccourciReglages: NSMenuItem?
    private let finEtatMenu = NSMenuItem.separator()
    private var lignesEtatMenu: [NSMenuItem] = []
    private var appareilsMenu: [AppareilMenu]?
    private var applicationsMenu: [CatalogueApps.App]?
    private var joignabiliteMenu: [String: String] = [:]
    private var derniereLectureMenu: Date?
    private var chargementMenu: Task<Void, Never>?
    private var menusPortail: [NSMenuItem] = []
    private lazy var atelier = AtelierIPA(runtime: runtime)
    private var fenetreAtelier: NSWindow?
    private var fenetre: NSWindow!
    private var page: WKWebView!
    private var importingBuild = false
    private var libraryAcceptsBuild = false
    private var importLiveContainer: Process?
    private var companionService: Process?
    private var moteur: Process?
    private var chargement: Task<Void, Never>?
    private let indication = NSTextField(wrappingLabelWithString: "")
    private let rechargerPortail = NSButton(title: "Try Again", target: nil, action: nil)
    private var destinationPortail: String?
    private var dernierRedemarrageWeb: Date?
    private let monde = WKContentWorld.world(name: "SignatureIOS")
    private var filtrageInstalle = false
    private func cleInstallation(_ nom: String) -> String {
        runtime.python != nil ? nom + ".packaged" : nom
    }
    private var cleGuide: String { cleInstallation("sideRelaySetupStep") }
    private var cleGuideReporte: String { cleInstallation("SideRelayDeferredSetupStep") }
    private var clePremiereApp: String { cleInstallation("SideRelayFirstApp") }
    private let cleDock = "sideRelayShowsInDock"
    private let cleAlertes = "sideRelayExpiryNotifications"
    private let cleAlertesEnvoyees = "sideRelayExpiryNotificationHistory"
    private let cleCellulaire = "sideRelayCellularSetupEnabled"
    private var operationCellulaire = false
    private var surveillanceExpiration: Task<Void, Never>?
    private var envoiAlerte = false
    private var ouvertureJumelage = false
    private lazy var jumelage = Jumelage(origine: origine)
    private var changementEnCours = false
    private var remplacementEnCours = false
    private let session = URLSession(configuration: .ephemeral)

    static func main() {
        let application = NSApplication.shared
        let delegue = SignatureIOS()
        application.delegate = delegue
        application.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        UserDefaults.standard.register(defaults: [cleDock: true])
        NSApp.setActivationPolicy(UserDefaults.standard.bool(forKey: cleDock) ? .regular : .accessory)
        installerMenuApplication()
        element = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        let symbole = logoSideRelay(taille: 19, modele: true)
        symbole.accessibilityDescription = "SideRelay"
        element.button?.image = symbole
        element.button?.toolTip = "SideRelay"

        let menu = NSMenu()
        ajouter("Open SideRelay", #selector(ouvrir), au: menu)
        menu.addItem(finEtatMenu)
        raccourciReglages = ajouter("Settings…", #selector(ouvrirReglages), au: menu)
        actualiserMenu()
        atelier.changementConfidentialite = { [weak self] masquer in
            self?.actualiserMenu()
            self?.page?.evaluateJavaScript("document.documentElement.toggleAttribute('data-sr-private', \(masquer))")
        }
        menu.addItem(.separator())
        ajouter("Quit SideRelay", #selector(quitter), au: menu)
        menu.delegate = self
        element.menu = menu

        preparerFenetre()
        ouvrir()
        demarrerCompagnon()
        chargerEtatMenu()
        surveillanceExpiration = Task { [weak self] in
            while !Task.isCancelled {
                self?.demarrerCompagnon()
                await self?.verifierExpiration()
                try? await Task.sleep(for: .seconds(300))
            }
        }
    }

    private func verifierExpiration() async {
        guard !envoiAlerte, UserDefaults.standard.bool(forKey: cleAlertes) else { return }
        envoiAlerte = true
        defer { envoiAlerte = false }
        guard let donnees = try? await commande(["catalogue-apps"]),
              let catalogue = try? JSONDecoder().decode(CatalogueApps.self, from: donnees) else { return }
        let maintenant = Int(Date().timeIntervalSince1970)
        var deja = UserDefaults.standard.dictionary(forKey: cleAlertesEnvoyees) as? [String: Int] ?? [:]
        deja = deja.filter { id, expiration in
            catalogue.apps.contains { $0.id == id && $0.profileExpiresAt == expiration }
        }
        let alertes = catalogue.apps.filter { app in
            guard app.installedAt != nil, app.autoRefresh != 0, let expiration = app.profileExpiresAt,
                  expiration != deja[app.id] else { return false }
            return expiration <= maintenant + 86_400 ||
                (expiration <= maintenant + 3 * 86_400 && app.latestError?.hasPrefix("[pairing-unreachable]") == true)
        }
        guard !alertes.isEmpty, UserDefaults.standard.bool(forKey: cleAlertes) else { return }
        let contenu = UNMutableNotificationContent()
        contenu.title = "SideRelay"
        contenu.body = alertes.count == 1
            ? "An app needs a refresh. Connect your iPhone by USB or check its connection in SideRelay."
            : "\(alertes.count) apps need a refresh. Connect your iPhone by USB or check its connection in SideRelay."
        let requete = UNNotificationRequest(identifier: "siderelay-signature-expiry", content: contenu, trigger: nil)
        do {
            try await UNUserNotificationCenter.current().add(requete)
            for app in alertes { deja[app.id] = app.profileExpiresAt }
            UserDefaults.standard.set(deja, forKey: cleAlertesEnvoyees)
        } catch {
            journal.error("Could not schedule the signature expiry notification.")
        }
    }

    private func installerMenuApplication() {
        let principal = NSMenu()
        let application = NSMenuItem()
        principal.addItem(application)
        let menu = NSMenu(title: "SideRelay")
        application.submenu = menu
        menu.addItem(withTitle: "About SideRelay", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        menu.addItem(.separator())
        let reglages = ajouter("Settings…", #selector(ouvrirReglages), au: menu)
        menusPortail.append(reglages)
        reglages.keyEquivalent = ","
        menu.addItem(.separator())
        let quitter = ajouter("Quit SideRelay", #selector(quitter), au: menu)
        quitter.keyEquivalent = "q"
        let fichier = NSMenuItem()
        principal.addItem(fichier)
        let menuFichier = NSMenu(title: "File")
        fichier.submenu = menuFichier
        ajouter("IPA Workshop…", #selector(ouvrirAtelierPreparation), au: menuFichier).keyEquivalent = "I"
        menusPortail.append(fichier)
        let edition = NSMenuItem()
        principal.addItem(edition)
        let menuEdition = NSMenu(title: "Edit")
        edition.submenu = menuEdition
        for (titre, action, touche) in [
            ("Undo", "undo:", "z"), ("Redo", "redo:", "Z"),
            ("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"),
            ("Select All", "selectAll:", "a"),
        ] {
            menuEdition.addItem(withTitle: titre, action: Selector(action), keyEquivalent: touche)
        }
        let affichage = NSMenuItem()
        principal.addItem(affichage)
        let menuAffichage = NSMenu(title: "View")
        affichage.submenu = menuAffichage
        for (titre, action, touche) in [
            ("Overview", #selector(ouvrirVueEnsemble), "1"), ("Devices", #selector(ouvrirAppareils), "2"),
            ("Apps", #selector(ouvrirApps), "3"), ("Apple Accounts", #selector(ouvrirComptes), "4"),
            ("Activity", #selector(ouvrirActivite), "5"), ("Store", #selector(ouvrirStore), "6"),
        ] {
            ajouter(titre, action, au: menuAffichage).keyEquivalent = touche
        }
        menusPortail.append(affichage)
        NSApp.mainMenu = principal
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        ouvrir()
        return true
    }

    @discardableResult
    private func ajouter(_ titre: String, _ action: Selector, au menu: NSMenu) -> NSMenuItem {
        let item = NSMenuItem(title: titre, action: action, keyEquivalent: "")
        item.target = self
        menu.addItem(item)
        return item
    }

    private var guideEnCours: Bool {
        (0...3).contains(UserDefaults.standard.integer(forKey: cleGuide))
    }

    private func actualiserMenu() {
        raccourciReglages?.isHidden = guideEnCours
        finEtatMenu.isHidden = guideEnCours
        for item in menusPortail { item.isHidden = guideEnCours }
        if let menu = element.menu { afficherEtatMenu(menu) }
    }

    private struct AppareilMenu: Decodable {
        let id: String
        let name: String
    }

    private struct CatalogueApps: Decodable {
        struct App: Decodable {
            let id: String
            let name: String?
            let bundleID: String
            let device: String?
            let installedAt: Int?
            let profileExpiresAt: Int?
            let autoRefresh: Int
            let latestError: String?
            let signingRepair: String?
        }
        let apps: [App]
    }

    private struct SondeMenu: Decodable {
        let reachable_ms: Int?
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        guard menu === element.menu else { return }
        chargerEtatMenu()
        afficherEtatMenu(menu)
    }

    private func chargerEtatMenu() {
        guard !guideEnCours, chargementMenu == nil,
              derniereLectureMenu.map({ Date().timeIntervalSince($0) >= 20 }) ?? true
        else { return }
        chargementMenu = Task { [weak self] in
            guard let self else { return }
            defer { chargementMenu = nil }
            async let appareils = requeteMenu([AppareilMenu].self, route: "list_devices")
            async let donnees = commande(["catalogue-apps"])
            appareilsMenu = try? await appareils
            if let contenu = try? await donnees,
               let catalogue = try? JSONDecoder().decode(CatalogueApps.self, from: contenu) {
                applicationsMenu = catalogue.apps.filter { $0.installedAt != nil }
            } else {
                applicationsMenu = nil
            }
            joignabiliteMenu = [:]
            if let menu = element.menu { afficherEtatMenu(menu) }
            let etats = await withTaskGroup(of: (String, String).self, returning: [String: String].self) { groupe in
                for appareil in appareilsMenu ?? [] {
                    groupe.addTask { [self] in
                        guard let sonde = try? await requeteMenu(SondeMenu.self, route: "probe_device",
                                                                appareil: appareil.id)
                        else { return (appareil.id, "Status Unavailable") }
                        return (appareil.id, sonde.reachable_ms == nil ? "Unreachable" : "Reachable")
                    }
                }
                var resultats: [String: String] = [:]
                for await (id, statut) in groupe { resultats[id] = statut }
                return resultats
            }
            joignabiliteMenu = etats
            derniereLectureMenu = Date()
            if let menu = element.menu { afficherEtatMenu(menu) }
        }
    }

    private func requeteMenu<T: Decodable & Sendable>(_ type: T.Type, route: String,
                                                      appareil: String? = nil) async throws -> T {
        var requete = URLRequest(url: origine.appending(path: "api/\(route)11318273670462819093"))
        requete.httpMethod = "POST"
        requete.timeoutInterval = 10
        requete.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        requete.setValue("application/json", forHTTPHeaderField: "Accept")
        var arguments = URLComponents()
        if let appareil { arguments.queryItems = [URLQueryItem(name: "device_id", value: appareil)] }
        requete.httpBody = Data((arguments.percentEncodedQuery ?? "").utf8)
        let (donnees, reponse) = try await session.data(for: requete)
        guard let http = reponse as? HTTPURLResponse, http.statusCode == 200, estLocal(http.url)
        else { throw ErreurPortail.indisponible }
        return try JSONDecoder().decode(type, from: donnees)
    }

    private func afficherEtatMenu(_ menu: NSMenu) {
        for ligne in lignesEtatMenu { menu.removeItem(ligne) }
        lignesEtatMenu.removeAll()
        guard !guideEnCours else { return }

        func ajouterLigne(_ titre: String, action: Selector? = nil, id: String? = nil) -> NSMenuItem {
            let ligne = NSMenuItem(title: titre, action: action, keyEquivalent: "")
            ligne.target = self
            ligne.representedObject = id
            return ligne
        }

        let attente = chargementMenu != nil && derniereLectureMenu == nil
        let indisponible = attente ? "Checking…" : "Status Unavailable"
        let prive = atelier.masquer
        var lignes = [NSMenuItem.separator(), .sectionHeader(title: "Devices")]
        if let appareils = appareilsMenu, !appareils.isEmpty {
            for (index, appareil) in appareils.enumerated() {
                let nom = prive ? "Device \(index + 1)" : appareil.name
                let etat = joignabiliteMenu[appareil.id] ?? "Checking…"
                lignes.append(ajouterLigne("\(nom) · \(etat)", action: #selector(ouvrirAppareilMenu(_:)), id: appareil.id))
            }
        } else {
            lignes.append(ajouterLigne(appareilsMenu == nil ? indisponible : "No Paired Devices"))
        }

        lignes.append(.sectionHeader(title: "Installed Apps"))
        if let applications = applicationsMenu, !applications.isEmpty {
            for (index, app) in applications.enumerated() {
                var nom = prive ? "App \(index + 1)" : app.name ?? app.bundleID
                if !prive, (appareilsMenu?.count ?? 0) > 1, let appareil = app.device {
                    nom += " (\(appareil))"
                }
                lignes.append(ajouterLigne("\(nom) · \(echeanceMenu(app))", action: #selector(ouvrirApps)))
            }
        } else {
            lignes.append(ajouterLigne(applicationsMenu == nil ? indisponible : "No Installed Apps"))
        }

        for ligne in lignes { menu.insertItem(ligne, at: menu.index(of: finEtatMenu)) }
        lignesEtatMenu = lignes
    }

    private func echeanceMenu(_ app: CatalogueApps.App) -> String {
        if app.signingRepair != nil { return "Re-signing Required" }
        guard let echeance = app.profileExpiresAt else { return "Expiry Unknown" }
        let secondes = TimeInterval(echeance) - Date().timeIntervalSince1970
        if secondes <= 0 { return "Signature Expired" }
        if secondes <= 86_400 { return "Expires Within 24 Hours" }
        return "\(Int(ceil(secondes / 86_400))) Days Left"
    }

    @objc private func ouvrirAppareilMenu(_ item: NSMenuItem) {
        guard let id = item.representedObject as? String, UUID(uuidString: id) != nil else {
            ouvrirAppareils()
            return
        }
        afficher(chemin: "/devices/\(id)")
    }

    private func memoriserEtapeGuide(_ etape: Int) {
        UserDefaults.standard.set(etape, forKey: cleGuide)
        actualiserMenu()
    }

    private func preparerFenetre() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let pont = PontComptes { [weak self] message in
            guard let self else { throw ErreurPortail.demandeInvalide }
            return try await self.traiter(message)
        }
        let contenuWeb = configuration.userContentController
        contenuWeb.addScriptMessageHandler(pont, contentWorld: monde, name: "signatureCompte")
        if let chemin = Bundle.main.url(forResource: "App", withExtension: "css"),
           let style = try? String(contentsOf: chemin, encoding: .utf8),
           let donnees = try? JSONEncoder().encode(style) {
            let css = String(decoding: donnees, as: UTF8.self)
            let script = "globalThis.sideRelayCSS = " + css
            contenuWeb.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart,
                                                 forMainFrameOnly: true, in: monde))
        }
        for (fichier, moment): (String, WKUserScriptInjectionTime) in [("Comptes", .atDocumentEnd), ("IPA", .atDocumentEnd), ("Jumelage", .atDocumentEnd), ("LotsIPA", .atDocumentEnd), ("Store", .atDocumentEnd), ("Bibliotheque", .atDocumentEnd), ("Outils", .atDocumentEnd), ("Guide", .atDocumentStart)] {
            if let chemin = Bundle.main.url(forResource: fichier, withExtension: "js"),
               let script = try? String(contentsOf: chemin, encoding: .utf8) {
                contenuWeb.addUserScript(WKUserScript(source: script, injectionTime: moment,
                                                     forMainFrameOnly: true, in: monde))
            }
        }
        if let chemin = Bundle.main.url(forResource: "Routes", withExtension: "js"),
           let script = try? String(contentsOf: chemin, encoding: .utf8) {
            contenuWeb.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart,
                                                 forMainFrameOnly: true, in: .page))
        }
        let portail = BuildDropWebView(frame: .zero, configuration: configuration)
        // Keep the pasteboard types WebKit needs for DOM drop events.
        portail.registerForDraggedTypes(portail.registeredDraggedTypes + [.fileURL])
        portail.acceptsBuild = { [weak self] in
            guard let self else { return false }
            return self.estPageApps() && self.libraryAcceptsBuild && !self.atelier.masquer && !self.importingBuild
        }
        portail.receiveBuild = { [weak self] url in
            Task { @MainActor in await self?.receiveDroppedBuild(url) }
        }
        page = portail
        page.navigationDelegate = self
        page.uiDelegate = self

        fenetre = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 860, height: 620),
                           styleMask: [.titled, .closable, .miniaturizable, .resizable],
                           backing: .buffered, defer: false)
        fenetre.title = "SideRelay"
        fenetre.delegate = self
        fenetre.titlebarSeparatorStyle = .none
        fenetre.minSize = NSSize(width: 520, height: 360)
        fenetre.isReleasedWhenClosed = false
        fenetre.center()

        let contenu = NSView()
        fenetre.contentView = contenu
        indication.alignment = .center
        indication.font = .systemFont(ofSize: 14)
        rechargerPortail.target = self
        rechargerPortail.action = #selector(relancerPortail)
        rechargerPortail.isHidden = true
        for vue in [page!, indication, rechargerPortail] {
            vue.translatesAutoresizingMaskIntoConstraints = false
            contenu.addSubview(vue)
        }
        NSLayoutConstraint.activate([
            page.leadingAnchor.constraint(equalTo: contenu.leadingAnchor),
            page.trailingAnchor.constraint(equalTo: contenu.trailingAnchor),
            page.topAnchor.constraint(equalTo: contenu.topAnchor),
            page.bottomAnchor.constraint(equalTo: contenu.bottomAnchor),
            indication.centerYAnchor.constraint(equalTo: contenu.centerYAnchor),
            indication.leadingAnchor.constraint(equalTo: contenu.leadingAnchor, constant: 32),
            indication.trailingAnchor.constraint(equalTo: contenu.trailingAnchor, constant: -32),
            rechargerPortail.topAnchor.constraint(equalTo: indication.bottomAnchor, constant: 12),
            rechargerPortail.centerXAnchor.constraint(equalTo: contenu.centerXAnchor),
        ])
    }

    @objc private func ouvrirAtelier() {
        if fenetreAtelier == nil {
            let fenetre = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 660, height: 590),
                                   styleMask: [.titled, .closable, .resizable],
                                   backing: .buffered, defer: false)
            fenetre.title = "SideRelay Workshop"
            fenetre.delegate = self
            fenetre.contentView = NSHostingView(rootView: VueAtelierIPA(atelier: atelier))
            fenetre.minSize = NSSize(width: 550, height: 465)
            fenetre.isReleasedWhenClosed = false
            fenetre.center()
            fenetreAtelier = fenetre
        }
        fenetreAtelier?.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    func windowWillClose(_ notification: Notification) {
        if (notification.object as? NSWindow) === fenetre { jumelage.fermer() }
        if (notification.object as? NSWindow) === fenetreAtelier {
            atelier.arreterCapture()
            atelier.motDePasseCertificat = ""
        }
    }

    private func ouvrirJournaux(jobID: String? = nil) {
        atelier.lireJournal(jobID: jobID)
        ouvrirAtelier()
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        guard let url = urls.first, atelier.proposerLien(url) else { return }
        ouvrirAtelier()
    }

    @objc private func ouvrir() { afficher(chemin: nil) }
    @objc private func ouvrirVueEnsemble() { afficher(chemin: "/") }
    @objc private func ouvrirAppareils() { afficher(chemin: "/devices") }
    @objc private func ouvrirApps() { afficher(chemin: "/?view=apps") }
    @objc private func ouvrirStore() { afficher(chemin: "/?view=store") }
    @objc private func ouvrirActivite() { afficher(chemin: "/queue") }
    @objc private func ouvrirAtelierPreparation() {
        atelier.onglet = "package"
        ouvrirAtelier()
    }
    @objc private func ouvrirComptes() { afficher(chemin: "/accounts") }
    @objc private func ouvrirReglages() { afficher(chemin: "/settings") }
    @objc private func ouvrirGuide() {
        let preferences = UserDefaults.standard
        let etape = min(3, max(0, preferences.integer(forKey: cleGuideReporte)))
        if preferences.object(forKey: cleGuideReporte) == nil { preferences.removeObject(forKey: clePremiereApp) }
        preferences.removeObject(forKey: cleGuideReporte)
        memoriserEtapeGuide(etape)
        afficher(chemin: ["/devices", "/", "/accounts", "/"][etape])
    }
    @objc private func quitter() { NSApp.terminate(nil) }
    @objc private func relancerPortail() { afficher(chemin: destinationPortail) }

    private func afficher(chemin: String?, activer: Bool = true) {
        if activer {
            fenetre.makeKeyAndOrderFront(nil)
            NSApp.activate()
        }
        if chemin == nil, indication.isHidden, page.url != nil, moteurEcoute() {
            return
        }
        chargement?.cancel()
        if let chemin { destinationPortail = chemin }
        let cible = destinationPortail
        indication.isHidden = false
        rechargerPortail.isHidden = true
        indication.stringValue = "Starting the signing service…"
        chargement = Task { [weak self] in
            guard let self else { return }
            do {
                try runtime.check()
                let configuration: [String: String]
                do {
                    let config = try await commande(["service-check"])
                    configuration = try JSONDecoder().decode([String: String].self, from: config)
                } catch is CancellationError { throw CancellationError() }
                catch {
                    throw SideRelayRuntime.MissingComponent(name: "service launcher or its Python libraries")
                }
                if let detail = configuration["error"] {
                    throw NSError(domain: "SideRelay.Startup", code: 1, userInfo: [NSLocalizedDescriptionKey: detail])
                }
                try await installerFiltrage()
                try Task.checkCancellation()
                for tentative in 0..<40 {
                    if let owner = moteurEcoutePID(), !estMoteur(owner) {
                        throw NSError(domain: "SideRelay.Startup", code: 2, userInfo: [
                            NSLocalizedDescriptionKey: "Port 18784 is already used by another process. Quit the other signing service, then try again."
                        ])
                    }
                    if await portailPret(), moteurEcoute() {
                        try Task.checkCancellation()
                        let url = cible.flatMap { URL(string: $0, relativeTo: origine)?.absoluteURL } ?? origine
                        page.load(URLRequest(url: url))
                        return
                    }
                    if tentative == 0 || tentative == 8 { try demarrerMoteur() }
                    try await Task.sleep(for: .milliseconds(400))
                }
                _ = moteurEcoute(diagnostiquer: true)
                throw NSError(domain: "SideRelay.Startup", code: 3, userInfo: [
                    NSLocalizedDescriptionKey: "The signing engine did not start. Check service.log in SideRelay’s data folder and try again."
                ])
            } catch is CancellationError {
                return
            } catch {
                journal.error("Portal startup failed: \(error.localizedDescription, privacy: .public)")
                indication.stringValue = error.localizedDescription
                rechargerPortail.isHidden = false
            }
        }
    }

    private func installerFiltrage() async throws {
        if filtrageInstalle { return }
        let regles = #"""
        [
            {"trigger":{"url-filter":".*"},"action":{"type":"block"}},
            {"trigger":{"url-filter":"^http://127[.]0[.]0[.]1:18784/"},"action":{"type":"ignore-previous-rules"}},
            {"trigger":{"url-filter":"^data:"},"action":{"type":"ignore-previous-rules"}},
            {"trigger":{"url-filter":"^blob:http://127[.]0[.]0[.]1:18784/"},"action":{"type":"ignore-previous-rules"}}
        ]
        """#
        guard let liste = try await WKContentRuleListStore.default().compileContentRuleList(
            forIdentifier: "SignatureIOSLocalOnly", encodedContentRuleList: regles
        ) else { throw ErreurPortail.indisponible }
        if !filtrageInstalle {
            page.configuration.userContentController.add(liste)
            filtrageInstalle = true
        }
    }

    private func portailPret() async -> Bool {
        let requete = URLRequest(url: origine, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 1)
        guard let (_, reponse) = try? await session.data(for: requete),
              let http = reponse as? HTTPURLResponse else { return false }
        return http.statusCode == 200 && estLocal(http.url)
    }

    private func demarrerMoteur() throws {
        if moteur?.isRunning == true { return }
        let processus = Process()
        runtime.configure(processus, [runtime.launcher.path, "servir", "--journal"])
        try processus.run()
        moteur = processus
    }

    private func moteurEcoutePID(diagnostiquer: Bool = false) -> Int32? {
        // Le port seul ne suffit pas avant de transmettre un mot de passe.
        let commande = Process()
        let sortie = Pipe()
        commande.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        commande.arguments = ["-nP", "-a", "-u", String(getuid()),
                              "-iTCP@127.0.0.1:\(Self.port)", "-sTCP:LISTEN", "-t"]
        commande.standardOutput = sortie
        commande.standardError = FileHandle.nullDevice
        do { try commande.run() } catch { return nil }
        let donnees = sortie.fileHandleForReading.readDataToEndOfFile()
        commande.waitUntilExit()
        let pids = Set(String(decoding: donnees, as: UTF8.self).split(whereSeparator: \.isWhitespace))
        guard commande.terminationStatus == 0, pids.count == 1,
              let pid = pids.first.flatMap({ Int32($0) }) else {
            if diagnostiquer { journal.error("Listener check returned status \(commande.terminationStatus) and \(pids.count) processes.") }
            return nil
        }
        return pid
    }

    private func estMoteur(_ pid: Int32, diagnostiquer: Bool = false) -> Bool {
        var tampon = [CChar](repeating: 0, count: 4096)
        let longueur = proc_pidpath(pid, &tampon, UInt32(tampon.count))
        guard longueur > 0 else {
            if diagnostiquer { journal.error("Could not identify the signing service executable: \(errno).") }
            return false
        }
        let chemin = tampon.withUnsafeBufferPointer { String(cString: $0.baseAddress!) }
        let attendu = runtime.engine.resolvingSymlinksInPath()
        let ecoute = URL(fileURLWithPath: chemin).resolvingSymlinksInPath().path == attendu.path
        if !ecoute && diagnostiquer { journal.error("The listener is not the bundled signing service.") }
        return ecoute
    }

    private func moteurEcoute(diagnostiquer: Bool = false) -> Bool {
        guard let pid = moteurEcoutePID(diagnostiquer: diagnostiquer) else { return false }
        return estMoteur(pid, diagnostiquer: diagnostiquer)
    }

    private func receiveDroppedBuild(_ url: URL) async {
        guard estPageApps(), libraryAcceptsBuild, !atelier.masquer else { return }
        let result = await importXcodeBuild(url)
        guard estPageApps(), !atelier.masquer else { return }
        page.callAsyncJavaScript("globalThis.sideRelayBuildDrop?.(result)", arguments: ["result": result],
                                 in: nil, in: monde, completionHandler: nil)
    }

    private func importXcodeBuild(_ url: URL) async -> [String: Any] {
        guard estPageApps(), !atelier.masquer, url.isFileURL, url.pathExtension.lowercased() == "app" else {
            return ["error": "Choose an Xcode .app built for a physical iPhone or iPad."]
        }
        guard !importingBuild else { return ["error": "An Xcode build is already being imported."] }
        importingBuild = true
        defer { importingBuild = false }
        page.callAsyncJavaScript("globalThis.sideRelayBuildDrop?.(result)", arguments: ["result": ["pending": true]],
                                 in: nil, in: monde, completionHandler: nil)
        do {
            let data = try await commande(["ipa-library", "import-build", url.path])
            guard estPageApps(), !atelier.masquer else { return ["cancelled": true] }
            if let result = try JSONSerialization.jsonObject(with: data) as? [String: Any] { return result }
        } catch {}
        return ["error": "SideRelay could not import the Xcode build."]
    }

    private func chooseXcodeBuild() async -> [String: Any] {
        let panel = NSOpenPanel()
        panel.title = "Import Xcode Build"
        panel.prompt = "Import"
        panel.message = "Choose a .app built for a physical iPhone or iPad."
        panel.canChooseFiles = true
        panel.canChooseDirectories = true
        panel.treatsFilePackagesAsDirectories = false
        let url: URL? = await withCheckedContinuation { continuation in
            panel.beginSheetModal(for: fenetre) { response in
                continuation.resume(returning: response == .OK ? panel.url : nil)
            }
        }
        guard let url else { return ["cancelled": true] }
        return await importXcodeBuild(url)
    }

    private func estPageApps() -> Bool { estVueAccueil("view=apps") }
    private func estPageStore() -> Bool { estVueAccueil("view=store") }

    private func estVueAccueil(_ vue: String) -> Bool {
        guard let url = page?.url else { return false }
        return estLocal(url) && (url.path.isEmpty || url.path == "/") && url.query == vue
    }

    private func estLocal(_ url: URL?) -> Bool {
        url?.scheme == origine.scheme && url?.host == origine.host && url?.port == Self.port
    }

    private nonisolated static func executer(_ runtime: SideRelayRuntime, _ script: URL, _ arguments: [String]) throws -> Data {
        let commande = Process()
        let sortie = Pipe()
        runtime.configure(commande, [script.path] + arguments)
        commande.standardOutput = sortie
        commande.standardError = FileHandle.nullDevice
        try commande.run()
        let donnees = sortie.fileHandleForReading.readDataToEndOfFile()
        commande.waitUntilExit()
        guard commande.terminationStatus == 0 else { throw ErreurPortail.indisponible }
        return donnees
    }

    private func commande(_ arguments: [String]) async throws -> Data {
        let runtime = self.runtime
        let script = runtime.launcher
        return try await Task.detached(priority: .userInitiated) {
            try Self.executer(runtime, script, arguments)
        }.value
    }

    private func peutPartagerIPA() -> Bool {
        guard let url = page?.url, estLocal(url), !atelier.masquer else { return false }
        return estPageApps() || estPageStore() || (url.path == "/" && url.query == nil && UserDefaults.standard.integer(forKey: cleGuide) == 3) || (url.pathComponents.count == 3 && url.pathComponents[1] == "devices" &&
                                  UUID(uuidString: url.lastPathComponent) != nil)
    }

    private func demarrerCompagnon() {
        guard companionService?.isRunning != true,
              FileManager.default.fileExists(atPath: runtime.data.appendingPathComponent("travail-signature/companion-enabled").path)
        else { return }
        let processus = Process()
        runtime.configure(processus, ["-m", "Interface.CompagnonService", runtime.data.path, String(Self.port)])
        processus.standardOutput = FileHandle.nullDevice
        processus.standardError = FileHandle.nullDevice
        do {
            try processus.run()
            companionService = processus
        } catch {
            journal.error("Could not start the SideRelay iPhone connection.")
        }
    }

    private func lancerImportLiveContainer(_ corps: [String: String]) async throws -> [String: Any] {
        guard peutPartagerIPA(), let pageOrigine = page.url, let id = corps["packageId"],
              id.range(of: "^(?:[a-f0-9]{32}|[a-f0-9]{64})$", options: .regularExpression) != nil,
              let appareil = corps["deviceId"], UUID(uuidString: appareil) != nil,
              pageOrigine.pathComponents.count != 3 || pageOrigine.lastPathComponent == appareil
        else { throw ErreurPortail.demandeInvalide }
        guard importLiveContainer?.isRunning != true else {
            return ["error": "A LiveContainer import is still open. Finish it or close its link first.", "linkInUse": true]
        }
        let processus = Process()
        let sortie = Pipe()
        runtime.configure(processus, ["-m", "Interface.ImportLiveContainer", runtime.data.path, id, appareil])
        processus.standardOutput = sortie
        processus.standardError = FileHandle.nullDevice
        try processus.run()
        importLiveContainer = processus
        let lecture = sortie.fileHandleForReading
        let donnees = await Task.detached(priority: .userInitiated) { () -> Data in
            var ligne = Data()
            while let bloc = try? lecture.read(upToCount: 4096), !bloc.isEmpty {
                ligne.append(bloc)
                if let fin = ligne.firstIndex(of: 10) { return ligne.prefix(upTo: fin) }
                if ligne.count > 8192 { break }
            }
            return Data()
        }.value
        guard peutPartagerIPA(), page.url == pageOrigine else {
            if processus.isRunning { processus.terminate() }
            return ["cancelled": true]
        }
        guard var resultat = try? JSONSerialization.jsonObject(with: donnees) as? [String: Any] else {
            if processus.isRunning { processus.terminate() }
            return ["error": "SideRelay could not start the LiveContainer import."]
        }
        if let lien = resultat.removeValue(forKey: "link") as? String {
            resultat["qr"] = try qrCode(lien)
        }
        return resultat
    }

    private func qrCode(_ lien: String) throws -> String {
        let filtre = CIFilter.qrCodeGenerator()
        filtre.message = Data(lien.utf8)
        filtre.correctionLevel = "M"
        guard let image = filtre.outputImage?.transformed(by: CGAffineTransform(scaleX: 5, y: 5)),
              let bitmap = CIContext().createCGImage(image, from: image.extent),
              let png = NSBitmapImageRep(cgImage: bitmap).representation(using: .png, properties: [:]) else {
            throw ErreurPortail.indisponible
        }
        return png.base64EncodedString()
    }

    private func etatGuide() async throws -> [String: Any] {
        let donnees = try await commande(["etat-portail"])
        guard var etat = try JSONSerialization.jsonObject(with: donnees) as? [String: Any]
        else { throw ErreurPortail.indisponible }
        let preferences = UserDefaults.standard
        if preferences.object(forKey: cleGuide) == nil,
           ["devices", "accounts", "apps"].allSatisfy({ (etat[$0] as? Int ?? 0) > 0 }) {
            memoriserEtapeGuide(-1)
        }
        if !preferences.bool(forKey: cleInstallation("SideRelaySetupPairFirst")) {
            if preferences.integer(forKey: cleGuide) == 1 { memoriserEtapeGuide(0) }
            preferences.set(true, forKey: cleInstallation("SideRelaySetupPairFirst"))
        }
        etat["step"] = preferences.integer(forKey: cleGuide)
        etat["firstApp"] = preferences.dictionary(forKey: clePremiereApp) as? [String: String] ?? [:]
        etat["setupDeferred"] = preferences.object(forKey: cleGuideReporte) != nil
        etat["expiryNotifications"] = preferences.bool(forKey: cleAlertes)
        etat["showInDock"] = NSApp.activationPolicy() == .regular
        etat["hidePersonalInfo"] = atelier.masquer
        etat["cellularTestAvailable"] = FileManager.default.isReadableFile(
            atPath: racine.appendingPathComponent("Essai-MDM/essai.py").path)
        etat["cellularSetupEnabled"] = preferences.bool(forKey: cleCellulaire)
        etat["version"] = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        etat["build"] = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
        return etat
    }

    private func commandeCellulaire(_ arguments: [String]) async throws -> Data {
        let runtime = self.runtime
        let script = racine.appendingPathComponent("Essai-MDM/essai.py")
        return try await Task.detached(priority: .userInitiated) {
            try Self.executer(runtime, script, arguments)
        }.value
    }

    private func etatCellulaire() async throws -> [String: Any] {
        let script = racine.appendingPathComponent("Essai-MDM/essai.py")
        guard FileManager.default.fileExists(atPath: script.path) else { return ["stage": "serverSetup"] }
        let donnees = try await commandeCellulaire(["setup-status"])
        guard let etat = try JSONSerialization.jsonObject(with: donnees) as? [String: Any] else {
            throw ErreurPortail.indisponible
        }
        return etat
    }

    private func traiterCellulaire(_ action: String, _ corps: [String: String]) async throws -> Any {
        let preferences = UserDefaults.standard
        if action == "cellularGuideLink" {
            let sources = [
                "nanomdm": "https://github.com/micromdm/nanomdm/releases/tag/v0.9.0",
                "scep": "https://github.com/micromdm/scep/releases/tag/v2.3.0",
                "pki": "https://www.apple.com/certificateauthority/",
            ]
            guard let source = corps["source"], let adresse = sources[source],
                  let url = URL(string: adresse) else { throw ErreurPortail.demandeInvalide }
            return NSWorkspace.shared.open(url)
        }
        if action == "cellularEnable" {
            guard !operationCellulaire, let valeur = corps["enabled"], ["true", "false"].contains(valeur) else {
                throw ErreurPortail.demandeInvalide
            }
            preferences.set(valeur == "true", forKey: cleCellulaire)
            return preferences.bool(forKey: cleCellulaire)
        }
        guard preferences.bool(forKey: cleCellulaire) else { throw ErreurPortail.demandeInvalide }
        if action == "cellularStatus" { return try await etatCellulaire() }
        guard !atelier.masquer else { throw ErreurPortail.demandeInvalide }
        guard !operationCellulaire else { throw ErreurPortail.indisponible }
        operationCellulaire = true
        defer { operationCellulaire = false }

        switch action {
        case "cellularApplePortal":
            return NSWorkspace.shared.open(URL(string: "https://identity.apple.com/pushcert/")!)
        case "cellularRequest":
            guard let email = corps["email"], email.count <= 254,
                  try await etatCellulaire()["stage"] as? String == "certificate" else {
                throw ErreurPortail.demandeInvalide
            }
            _ = try await commandeCellulaire(["request", email])
            fallthrough
        case "cellularShowRequest":
            let fichier = racine.appendingPathComponent("Essai-MDM/Demande-APNs-SideRelay.txt")
            guard FileManager.default.fileExists(atPath: fichier.path) else { throw ErreurPortail.indisponible }
            NSWorkspace.shared.activateFileViewerSelecting([fichier])
            return true
        case "cellularImport":
            guard try await etatCellulaire()["stage"] as? String == "certificate" else {
                throw ErreurPortail.demandeInvalide
            }
            let panneau = NSOpenPanel()
            panneau.title = "Import Apple Push Certificate"
            panneau.prompt = "Import"
            panneau.message = "Select the .pem file downloaded from Apple Push Certificates Portal."
            panneau.allowedContentTypes = [UTType(filenameExtension: "pem") ?? .data]
            let url: URL? = await withCheckedContinuation { continuation in
                panneau.beginSheetModal(for: fenetre) { reponse in
                    continuation.resume(returning: reponse == .OK ? panneau.url : nil)
                }
            }
            guard let url else { return false }
            guard page.url?.path == "/settings", !atelier.masquer, url.pathExtension.lowercased() == "pem" else {
                throw ErreurPortail.demandeInvalide
            }
            _ = try await commandeCellulaire(["import-apns", url.path])
            return true
        case "cellularQR", "cellularCopyLink":
            let donnees = try await commandeCellulaire(["setup-link"])
            let lien = String(decoding: donnees, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            guard page.url?.path == "/settings", !atelier.masquer, lien.count < 1024 else {
                throw ErreurPortail.demandeInvalide
            }
            if action == "cellularCopyLink" {
                NSPasteboard.general.clearContents()
                return NSPasteboard.general.setString(lien, forType: .string)
            }
            return try qrCode(lien)
        case "cellularTest":
            _ = try await commandeCellulaire(["setup-test"])
            return try await etatCellulaire()
        default:
            throw ErreurPortail.demandeInvalide
        }
    }

    private func changerConnexion(_ mode: String) async throws -> Any {
        guard !changementEnCours else { throw ErreurPortail.indisponible }
        changementEnCours = true
        defer { changementEnCours = false }
        let gereParApp = moteur?.isRunning == true
        let donnees = try await commande(["connexion", mode] + (gereParApp ? ["--manuel"] : []))
        if let reponse = try JSONSerialization.jsonObject(with: donnees) as? [String: Any],
           reponse["restart"] as? Bool == true, let moteur, moteur.isRunning {
            moteur.terminate()
            for _ in 0..<40 {
                if !moteur.isRunning { break }
                try await Task.sleep(for: .milliseconds(250))
            }
            guard !moteur.isRunning else { throw ErreurPortail.indisponible }
            try demarrerMoteur()
        }
        let valeur = mode == "bonjour" ? "true" : "false"
        for _ in 0..<32 {
            var requete = URLRequest(url: origine.appendingPathComponent("settings"))
            requete.timeoutInterval = 1
            if let (corps, reponse) = try? await session.data(for: requete),
               (reponse as? HTTPURLResponse)?.statusCode == 200,
               estLocal(reponse.url), moteurEcoute(),
               String(decoding: corps, as: UTF8.self).contains(#"mdns_enabled\":"# + valeur) {
                return ["mode": mode]
            }
            try await Task.sleep(for: .milliseconds(375))
        }
        throw ErreurPortail.indisponible
    }

    private func ouvrirOutilJumelage() async throws {
        guard !ouvertureJumelage else { return }
        ouvertureJumelage = true
        defer { ouvertureJumelage = false }
        let data = try await commande(["outil-jumelage"])
        let chemin = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        let url = URL(fileURLWithPath: chemin)
        guard chemin.hasPrefix("/Volumes/"), url.lastPathComponent == "idevice_pair.app"
        else { throw ErreurPortail.indisponible }
        _ = try await NSWorkspace.shared.openApplication(at: url, configuration: .init())
    }

    private func traiter(_ message: WKScriptMessage) async throws -> Any {
        guard message.frameInfo.isMainFrame, estLocal(page.url), estLocal(message.frameInfo.request.url),
              message.frameInfo.securityOrigin.protocol == origine.scheme,
              message.frameInfo.securityOrigin.host == origine.host,
              message.frameInfo.securityOrigin.port == Self.port,
              let corps = message.body as? [String: String], let action = corps["action"],
              moteurEcoute() else { throw ErreurPortail.demandeInvalide }
        let chemin = page.url?.path ?? ""
        switch action {
        case "importLiveContainer":
            return try await lancerImportLiveContainer(corps)
        case "prepareCompanion":
            guard peutPartagerIPA(), let pageOrigine = page.url,
                  let appareil = corps["deviceId"], UUID(uuidString: appareil) != nil,
                  let compte = corps["accountId"], UUID(uuidString: compte) != nil,
                  pageOrigine.pathComponents.count != 3 || pageOrigine.lastPathComponent == appareil
            else { throw ErreurPortail.demandeInvalide }
            let data = try await commande(["companion-ipa", appareil, compte])
            guard peutPartagerIPA(), page.url == pageOrigine else { throw ErreurPortail.demandeInvalide }
            let result = try JSONSerialization.jsonObject(with: data)
            return result
        case "configureLiveContainer":
            guard peutPartagerIPA(), let pageOrigine = page.url,
                  let appareil = corps["deviceId"], UUID(uuidString: appareil) != nil,
                  pageOrigine.pathComponents.count != 3 || pageOrigine.lastPathComponent == appareil
            else { throw ErreurPortail.demandeInvalide }
            let data = try await commande(["livecontainer-setup", appareil])
            guard peutPartagerIPA(), page.url == pageOrigine else { throw ErreurPortail.demandeInvalide }
            return try JSONSerialization.jsonObject(with: data)
        case "enableCompanion":
            guard peutPartagerIPA() else { throw ErreurPortail.demandeInvalide }
            let data = try await commande(["enable-companion"])
            let result = try JSONSerialization.jsonObject(with: data)
            if (result as? [String: Any])?["enabled"] as? Bool == true { demarrerCompagnon() }
            return result
        case "closeLiveContainerLink":
            guard peutPartagerIPA() else { throw ErreurPortail.demandeInvalide }
            if let importLiveContainer, importLiveContainer.isRunning { importLiveContainer.terminate() }
            return true
        case "setupShowPersonalInfo":
            guard guideEnCours, ["/", "/devices", "/accounts"].contains(chemin), page.url?.query == nil
            else { throw ErreurPortail.demandeInvalide }
            if atelier.masquer { atelier.basculerConfidentialite() }
            return true
        case "setupUSB":
            guard chemin == "/devices", !atelier.masquer,
                  UserDefaults.standard.integer(forKey: cleGuide) == 0 else { throw ErreurPortail.demandeInvalide }
            return try await JSONSerialization.jsonObject(with: commande(["setup-usb"]))
        case "setupFirstApp", "setupVerifyFirstApp", "setupConfirmOpened", "setupResetFirstApp":
            let preferences = UserDefaults.standard
            guard chemin == "/", page.url?.query == nil, !atelier.masquer,
                  preferences.integer(forKey: cleGuide) == 3 else { throw ErreurPortail.demandeInvalide }
            let cle = clePremiereApp
            if action == "setupResetFirstApp" {
                preferences.removeObject(forKey: cle)
                return true
            }
            if action == "setupFirstApp" {
                guard let mode = corps["mode"], ["native", "livecontainer"].contains(mode),
                      let id = corps["id"], UUID(uuidString: id) != nil else { throw ErreurPortail.demandeInvalide }
                var valeurs = ["mode": mode, "id": id]
                if mode == "livecontainer" {
                    guard let bundle = corps["bundle"], bundle.range(of: "^[A-Za-z0-9][A-Za-z0-9.\\-]{0,254}$",
                            options: .regularExpression) != nil else { throw ErreurPortail.demandeInvalide }
                    valeurs["bundle"] = bundle
                }
                preferences.set(valeurs, forKey: cle)
                return true
            }
            guard var premier = preferences.dictionary(forKey: cle) as? [String: String],
                  let mode = premier["mode"], let id = premier["id"] else { return ["state": "untracked"] }
            let data = try await commande(["setup-verification", mode, id] + (premier["bundle"].map { [$0] } ?? []))
            guard preferences.dictionary(forKey: cle) as? [String: String] == premier,
                  preferences.integer(forKey: cleGuide) == 3, !atelier.masquer,
                  page.url?.path == "/", page.url?.query == nil,
                  var resultat = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { throw ErreurPortail.demandeInvalide }
            if resultat["state"] as? String == "installed" {
                if action == "setupConfirmOpened" {
                    premier["opened"] = "yes"
                    preferences.set(premier, forKey: cle)
                }
                if resultat["refresh"] as? String == "configured",
                   let device = resultat["deviceID"] as? String {
                    let sonde = try? await requeteMenu(SondeMenu.self, route: "probe_device", appareil: device)
                    guard preferences.dictionary(forKey: cle) as? [String: String] == premier,
                          preferences.integer(forKey: cleGuide) == 3, !atelier.masquer,
                          page.url?.path == "/", page.url?.query == nil else { throw ErreurPortail.demandeInvalide }
                    resultat["refresh"] = sonde?.reachable_ms != nil ? "ready" : "unreachable"
                }
            }
            resultat["opened"] = premier["opened"] == "yes"
            return resultat
        case "portal":
            return try await etatGuide()
        case "cellularEnable", "cellularStatus", "cellularGuideLink", "cellularApplePortal", "cellularRequest",
             "cellularShowRequest", "cellularImport", "cellularQR", "cellularCopyLink", "cellularTest":
            guard chemin == "/settings" else { throw ErreurPortail.demandeInvalide }
            return try await traiterCellulaire(action, corps)
        case "privacyStatus":
            return atelier.masquer
        case "privacyChange":
            guard chemin == "/settings", let valeur = corps["hide"], ["true", "false"].contains(valeur)
            else { throw ErreurPortail.demandeInvalide }
            if atelier.masquer != (valeur == "true") { atelier.basculerConfidentialite() }
            return atelier.masquer
        case "restartSetup":
            guard chemin == "/settings" else { throw ErreurPortail.demandeInvalide }
            ouvrirGuide()
            return true
        case "expiryNotifications":
            guard chemin == "/settings", let valeur = corps["enabled"], ["true", "false"].contains(valeur)
            else { throw ErreurPortail.demandeInvalide }
            if valeur == "false" {
                UserDefaults.standard.set(false, forKey: cleAlertes)
                UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ["siderelay-signature-expiry"])
                return false
            }
            let autorise = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert])
            UserDefaults.standard.set(autorise, forKey: cleAlertes)
            if autorise { Task { await verifierExpiration() } }
            return autorise
        case "dockVisibility":
            guard chemin == "/settings", let valeur = corps["visible"], ["true", "false"].contains(valeur)
            else { throw ErreurPortail.demandeInvalide }
            let visible = valeur == "true"
            guard NSApp.setActivationPolicy(visible ? .regular : .accessory)
            else { throw ErreurPortail.indisponible }
            UserDefaults.standard.set(visible, forKey: cleDock)
            fenetre.makeKeyAndOrderFront(nil)
            NSApp.activate()
            return NSApp.activationPolicy() == .regular
        case "replaceCertificate", "revokeCertificate":
            let manuel = corps["action"] == "revokeCertificate"
            guard !atelier.masquer,
                  manuel ? chemin == "/accounts" : (chemin == "/queue" || estPageApps())
            else { throw ErreurPortail.demandeInvalide }
            do {
                let demande = manuel ? try await preparerRevocation(corps) : corps
                guard !manuel || (page.url?.path == "/accounts" && !atelier.masquer) else {
                    throw ErreurPortail.demandeInvalide
                }
                return try await remplacerCertificat(demande, manuel: manuel)
            }
            catch {
                let erreur = error as NSError
                let detail = erreur.domain == "SideRelay.Certificate" ? erreur.localizedDescription
                    : "SideRelay could not confirm the result. Check Activity before trying again."
                return ["error": detail]
            }
        case "showSignedBatch":
            guard estPageApps(), !atelier.masquer,
                  let id = corps["batchId"], UUID(uuidString: id) != nil
            else { throw ErreurPortail.demandeInvalide }
            let depot = runtime.data.appendingPathComponent("ipas/signed", isDirectory: true).resolvingSymlinksInPath()
            let dossier = depot.appendingPathComponent(id, isDirectory: true).resolvingSymlinksInPath()
            var existe: ObjCBool = false
            guard dossier.deletingLastPathComponent() == depot,
                  FileManager.default.fileExists(atPath: dossier.path, isDirectory: &existe), existe.boolValue,
                  NSWorkspace.shared.open(dossier)
            else { throw ErreurPortail.indisponible }
            return true
        case "appsActions":
            guard estPageApps(), let vue = corps["view"], ["Installed", "Library"].contains(vue)
            else { throw ErreurPortail.demandeInvalide }
            var commandes: [(String, String, String, Bool)] = [
                ("Set Up SideRelay on iPhone…", "companion", "iphone", !atelier.masquer),
                ("IPA Workshop…", "workshop", "shippingbox", true),
                ("Refresh List", "refresh", "arrow.clockwise", corps["refresh"] == "1"),
            ]
            if vue == "Library", !atelier.masquer {
                commandes.insert(contentsOf: [
                    ("Import Xcode Build…", "importBuild", "hammer", !importingBuild),
                    ("Batch History…", "batches", "clock.arrow.circlepath", true),
                ], at: 0)
            }
            return try menuActions(corps, commandes, separateurAvant: vue == "Library" && !atelier.masquer ? "workshop" : nil)
        case "libraryDropEnabled":
            guard estPageApps(), !atelier.masquer else { throw ErreurPortail.demandeInvalide }
            libraryAcceptsBuild = corps["enabled"] == "yes"
            return true
        case "chooseXcodeBuild":
            guard estPageApps(), !atelier.masquer else { throw ErreurPortail.demandeInvalide }
            return await chooseXcodeBuild()
        case "ipaLibrary":
            let operationsStore = ["list", "store", "refresh-store", "store-image", "add", "refresh", "remove",
                                   "download", "edit-path"]
            guard let operation = corps["operation"], !atelier.masquer,
                  estPageApps() || (estPageStore() && operationsStore.contains(operation))
            else { throw ErreurPortail.demandeInvalide }
            let pageOrigine = page.url
            var arguments = ["ipa-library", operation == "edit-path" ? "signing-path" : operation]
            switch operation {
            case "list", "store":
                break
            case "refresh-store":
                if corps["force"] == "yes" { arguments.append("all") }
            case "store-image":
                guard let id = corps["sourceId"], UUID(uuidString: id) != nil,
                      let address = corps["address"], address.count <= 4096, address.hasPrefix("https://")
                else { throw ErreurPortail.demandeInvalide }
                arguments += [id, address]
            case "inspect", "diagnose", "signing-path", "edit-path", "icon":
                guard let id = corps["packageId"],
                      id.range(of: "^(?:[0-9a-f]{32}|[0-9a-f]{64})$", options: .regularExpression) != nil
                else { throw ErreurPortail.demandeInvalide }
                arguments.append(id)
                if operation == "diagnose", let device = corps["deviceId"], !device.isEmpty {
                    guard UUID(uuidString: device) != nil else { throw ErreurPortail.demandeInvalide }
                    arguments.append(device)
                }
            case "add":
                guard let url = corps["url"], url.count <= 4096, url.hasPrefix("https://")
                else { return ["error": "Enter an HTTPS URL for the source."] }
                arguments.append(url)
            case "refresh", "remove", "download":
                guard let id = corps["sourceId"], UUID(uuidString: id) != nil
                else { throw ErreurPortail.demandeInvalide }
                arguments.append(id)
                if operation == "download" {
                    guard let bundle = corps["bundleId"], !bundle.isEmpty, bundle.count <= 255,
                          bundle.range(of: "^[A-Za-z0-9][A-Za-z0-9.-]*$", options: .regularExpression) != nil,
                          let version = corps["versionId"], version.count == 64,
                          version.range(of: "^[0-9a-f]+$", options: .regularExpression) != nil
                    else { throw ErreurPortail.demandeInvalide }
                    arguments += [bundle, version]
                }
            default:
                throw ErreurPortail.demandeInvalide
            }
            let data = try await commande(arguments)
            guard page.url == pageOrigine, !atelier.masquer else { throw ErreurPortail.demandeInvalide }
            let result = try JSONSerialization.jsonObject(with: data)
            if ["signing-path", "edit-path"].contains(operation), let path = (result as? [String: Any])?["path"] as? String {
                guard !atelier.occupé else { return ["error": "The IPA Workshop is busy."] }
                ouvrirAtelierPreparation()
                atelier.importer(URL(fileURLWithPath: path), profils: operation == "signing-path")
                return ["opened": true]
            }
            return result
        case "appsCatalog":
            guard peutPartagerIPA() else { throw ErreurPortail.demandeInvalide }
            let pageOrigine = page.url
            let data = try await commande(["catalogue-apps"])
            guard page.url == pageOrigine, !atelier.masquer else { throw ErreurPortail.demandeInvalide }
            return try JSONSerialization.jsonObject(with: data)
        case "liveContainerInventory", "installedAppIcon":
            guard estPageApps(), !atelier.masquer else { throw ErreurPortail.demandeInvalide }
            var arguments = ["inventaire-livecontainer"]
            if action == "installedAppIcon" {
                guard let appID = corps["appID"], UUID(uuidString: appID) != nil
                else { throw ErreurPortail.demandeInvalide }
                arguments = ["installed-app-icon", appID]
            }
            let data = try await commande(arguments)
            guard estPageApps(), !atelier.masquer else { throw ErreurPortail.demandeInvalide }
            return try JSONSerialization.jsonObject(with: data)
        case "discardInstallAttempt":
            guard (chemin == "/" || chemin.isEmpty), page.url?.query == "view=apps", !atelier.masquer,
                  let appID = corps["appID"], UUID(uuidString: appID) != nil
            else { throw ErreurPortail.demandeInvalide }
            let data = try await commande(["retirer-tentative", appID])
            return try JSONSerialization.jsonObject(with: data)
        case "deviceInventory":
            guard chemin == "/devices", !atelier.masquer else { throw ErreurPortail.demandeInvalide }
            let data = try await commande(["appareils-detectes"])
            guard !atelier.masquer else { throw ErreurPortail.demandeInvalide }
            return try JSONSerialization.jsonObject(with: data)
        case "nearbyDevices":
            guard chemin == "/devices", !atelier.masquer else { throw ErreurPortail.demandeInvalide }
            let resultat = await Task.detached(priority: .userInitiated) { DecouverteBonjour.rechercher() }.value
            guard !atelier.masquer else { throw ErreurPortail.demandeInvalide }
            return ["status": resultat.statut, "devices": resultat.appareils.map {
                ["name": $0.nom, "address": $0.adresse, "remotePairing": $0.jumelageDistant]
            }]
        case "startPairing":
            guard chemin == "/devices", !atelier.masquer, let mode = corps["mode"] else {
                throw ErreurPortail.demandeInvalide
            }
            return jumelage.commencer(mode: mode, appareil: corps["device"] ?? "", adresse: corps["address"] ?? "",
                                      simplifiedUSB: corps["simplifiedUSB"] == "1")
        case "pairingStatus":
            guard chemin == "/devices", !atelier.masquer else { throw ErreurPortail.demandeInvalide }
            return jumelage.etat
        case "retryPairing":
            guard chemin == "/devices", !atelier.masquer else { throw ErreurPortail.demandeInvalide }
            return jumelage.reessayer(adresse: corps["address"] ?? "")
        case "closePairing":
            guard chemin == "/devices" else { throw ErreurPortail.demandeInvalide }
            jumelage.fermer()
            return true
        case "openPairingTool":
            guard chemin == "/devices" else { throw ErreurPortail.demandeInvalide }
            try await ouvrirOutilJumelage()
            return true
        case "workshop":
            ouvrirAtelierPreparation()
            return true
        case "installLogs":
            let jobID = corps["jobID"]
            if let jobID {
                guard chemin == "/", page.url?.query == "view=apps", !atelier.masquer,
                      UUID(uuidString: jobID) != nil else { throw ErreurPortail.demandeInvalide }
            } else {
                guard chemin == "/queue", !atelier.masquer else { throw ErreurPortail.demandeInvalide }
            }
            ouvrirJournaux(jobID: jobID)
            return true
        case "activity", "clearActivity":
            guard chemin == "/queue", !atelier.masquer else { throw ErreurPortail.demandeInvalide }
            let data = try await commande([action == "activity" ? "activite" : "effacer-activite"])
            guard !atelier.masquer else { throw ErreurPortail.demandeInvalide }
            return try JSONSerialization.jsonObject(with: data)
        case "setupStep":
            guard let etape = corps["step"].flatMap(Int.init), (-1...3).contains(etape) else {
                throw ErreurPortail.demandeInvalide
            }
            let preferences = UserDefaults.standard
            let actuelle = preferences.integer(forKey: cleGuide)
            guard (0...3).contains(actuelle) else { throw ErreurPortail.demandeInvalide }
            if etape == -1 {
                if corps["defer"] == "yes" {
                    preferences.set(actuelle, forKey: cleGuideReporte)
                } else {
                    guard actuelle == 3,
                          (preferences.dictionary(forKey: clePremiereApp)?["opened"] as? String) == "yes"
                    else { throw ErreurPortail.demandeInvalide }
                    preferences.removeObject(forKey: cleGuideReporte)
                    preferences.removeObject(forKey: clePremiereApp)
                }
            }
            memoriserEtapeGuide(etape)
            return true
        case "connection":
            guard chemin == "/settings" || chemin == "/" || chemin.isEmpty,
                  let mode = corps["mode"], ["tailscale", "bonjour"].contains(mode) else {
                throw ErreurPortail.demandeInvalide
            }
            return try await changerConnexion(mode)
        case "pairingAddress":
            guard chemin == "/devices" else { throw ErreurPortail.demandeInvalide }
            let resultat = try await commande(["adresse-tailscale"])
            let adresse = String(decoding: resultat, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            var ipv4 = in_addr()
            guard inet_pton(AF_INET, adresse, &ipv4) == 1 else { throw ErreurPortail.indisponible }
            return adresse
        default:
            break
        }
        guard chemin == "/accounts"
        else { throw ErreurPortail.demandeInvalide }
        switch action {
        case "accountActions":
            return try menuActionsCompte(corps)
        case "status":
            return ["saved": trousseau.contientUnCompte()]
        case "fill":
            guard let identifiants = try trousseau.lire() else { throw ErreurPortail.demandeInvalide }
            return ["login": identifiants.identifiant, "password": identifiants.motDePasse]
        case "certificate":
            guard let base64 = corps["certificate"], base64.count <= 131_072,
                  let fichier = Data(base64Encoded: base64), fichier.first == 0x30 else {
                throw ErreurPortail.demandeInvalide
            }
            enregistrerCertificat(fichier)
            return true
        case "save":
            guard let identifiant = corps["login"], identifiant.contains("@"), identifiant.count <= 320,
                  let motDePasse = corps["password"], !motDePasse.isEmpty, motDePasse.count <= 1024 else {
                throw ErreurPortail.demandeInvalide
            }
            try trousseau.enregistrer(IdentifiantsApple(identifiant: identifiant, motDePasse: motDePasse))
            return true
        default:
            throw ErreurPortail.demandeInvalide
        }
    }

    private func preparerRevocation(_ demande: [String: String]) async throws -> [String: String] {
        guard !remplacementEnCours,
              let account = demande["accountID"], UUID(uuidString: account) != nil,
              let serial = demande["serial"], serial.range(of: "^[0-9A-Fa-f]{1,80}$", options: .regularExpression) != nil
        else { throw ErreurPortail.demandeInvalide }
        var request = URLRequest(url: origine.appending(path: "api/prepare_certificate_revocation11318273670462819093"))
        request.httpMethod = "POST"
        request.timeoutInterval = 60
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = Data("account_id=\(account)&serial=\(serial)".utf8)
        guard let plan = try await reponseCertificat(request) as? [String: Any],
              let token = plan["token"] as? String,
              let certificates = plan["certificates"] as? [[String: Any]], certificates.count == 1,
              let certificat = certificates.first, let numero = certificat["serial"] as? String,
              let label = certificat["label"] as? String, let apps = certificat["apps"] as? [[String: Any]]
        else { throw ErreurPortail.demandeInvalide }
        let lignes = apps.compactMap { app -> String? in
            guard let name = app["name"] as? String, let device = app["device"] as? String else { return nil }
            if app["certain"] as? Bool != true { return "Possibly affected: \(name) · \(device) (signature not recorded)" }
            let recovery = app["can_repair"] as? Bool == true ? "re-signing will be queued" : "IPA needed to re-sign"
            return "\(name) · \(device) (\(recovery))"
        }
        return ["token": token, "serial": numero, "certificate": label, "impact": lignes.joined(separator: "\n")]
    }

    private func remplacerCertificat(_ demande: [String: String], manuel: Bool) async throws -> Any {
        guard !remplacementEnCours,
              let token = demande["token"], UUID(uuidString: token) != nil,
              let numero = demande["serial"], numero.range(of: "^[0-9A-Fa-f]{1,80}$", options: .regularExpression) != nil,
              let certificat = demande["certificate"], !certificat.isEmpty, certificat.count <= 500,
              let impact = demande["impact"], impact.count <= 12_000
        else { throw ErreurPortail.demandeInvalide }
        remplacementEnCours = true
        defer { remplacementEnCours = false }

        let confirmation = NSAlert()
        confirmation.alertStyle = .warning
        confirmation.messageText = "Revoke this development certificate?"
        confirmation.informativeText = [certificat, impact.isEmpty ? "No SideRelay app is linked to this certificate." : impact,
            "Apps installed outside SideRelay may also stop opening."].joined(separator: "\n\n")
        let annuler = confirmation.addButton(withTitle: "Cancel")
        annuler.keyEquivalent = "\r"
        let revoquer = confirmation.addButton(withTitle: manuel ? "Revoke Certificate" : "Revoke and Replace")
        revoquer.hasDestructiveAction = true
        let choix = await withCheckedContinuation { continuation in
            confirmation.beginSheetModal(for: fenetre) { continuation.resume(returning: $0) }
        }
        guard choix == .alertSecondButtonReturn else { return ["cancelled": true] }

        let cle = try Data(contentsOf: runtime.data.appendingPathComponent("cle"))
        guard cle.count == 64 else { throw ErreurPortail.indisponible }
        let message = Data("SideRelay certificate replacement\n\(token)\n\(numero)".utf8)
        let code = HMAC<SHA256>.authenticationCode(for: message, using: SymmetricKey(data: cle))
            .map { String(format: "%02x", $0) }.joined()
        var requete = URLRequest(url: origine.appending(path: "api/replace_certificate11318273670462819093"))
        requete.httpMethod = "POST"
        requete.timeoutInterval = 120
        requete.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        requete.setValue("application/json", forHTTPHeaderField: "Accept")
        requete.setValue(code, forHTTPHeaderField: "X-SideRelay-Approval")
        requete.httpBody = Data("token=\(token)&serial=\(numero)".utf8)
        return try await reponseCertificat(requete)
    }

    private func reponseCertificat(_ requete: URLRequest) async throws -> Any {
        let (donnees, reponse) = try await session.data(for: requete)
        guard let reponse = reponse as? HTTPURLResponse, estLocal(reponse.url) else {
            throw ErreurPortail.indisponible
        }
        if reponse.statusCode != 200 {
            let details = (try? JSONSerialization.jsonObject(with: donnees)) as? [String: String]
            let message = details?["ServerError"] ?? details?["error"] ?? String(decoding: donnees, as: UTF8.self)
            throw NSError(domain: "SideRelay.Certificate", code: reponse.statusCode,
                          userInfo: [NSLocalizedDescriptionKey: message])
        }
        return try JSONSerialization.jsonObject(with: donnees)
    }

    private func menuActionsCompte(_ donnees: [String: String]) throws -> String {
        guard !atelier.masquer else { throw ErreurPortail.demandeInvalide }
        return try menuActions(donnees, [
            ("View App IDs", "appIDs", "number", donnees["appIDs"] == "1"),
            ("Export LiveContainer Certificate", "exportCert", "square.and.arrow.up", donnees["exportCert"] == "1"),
            ("Remove Account…", "remove", "person.crop.circle.badge.minus", donnees["remove"] == "1"),
        ], separateurAvant: "remove")
    }

    private func menuActions(_ donnees: [String: String], _ commandes: [(String, String, String, Bool)],
                             separateurAvant: String?) throws -> String {
        guard let x = donnees["x"].flatMap(Double.init), let y = donnees["y"].flatMap(Double.init),
              x.isFinite, y.isFinite, x >= 0, x <= page.bounds.width,
              y >= 0, y <= page.bounds.height + 1
        else { throw ErreurPortail.demandeInvalide }

        let choix = ChoixMenu()
        let menu = NSMenu()
        menu.autoenablesItems = false
        for (titre, action, symbole, disponible) in commandes {
            if action == separateurAvant { menu.addItem(.separator()) }
            let item = NSMenuItem(title: titre, action: #selector(ChoixMenu.selectionner(_:)), keyEquivalent: "")
            item.target = choix
            item.representedObject = action
            item.isEnabled = disponible
            item.image = NSImage(systemSymbolName: symbole, accessibilityDescription: nil)
            menu.addItem(item)
        }
        let hauteur = page.isFlipped ? y : page.bounds.height - y
        menu.popUp(positioning: nil, at: NSPoint(x: x, y: hauteur), in: page)
        return choix.selection
    }

    private func enregistrerCertificat(_ donnees: Data) {
        let panneau = NSSavePanel()
        panneau.title = "Save LiveContainer Certificate"
        panneau.nameFieldStringValue = "LiveContainer.p12"
        panneau.allowedContentTypes = [UTType(filenameExtension: "p12") ?? .data]
        panneau.beginSheetModal(for: fenetre) { [weak self] reponse in
            guard let self, reponse == .OK, let destination = panneau.url else { return }
            do {
                try ecrireCertificat(donnees, dans: destination)
            } catch {
                let erreur = NSAlert()
                erreur.messageText = "Could not save the LiveContainer certificate."
                erreur.beginSheetModal(for: fenetre)
            }
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        decisionHandler(estLocal(action.request.url) ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor reponse: WKNavigationResponse,
                 decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(estLocal(reponse.response.url) ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        libraryAcceptsBuild = false
        if webView.url?.path != "/devices" { jumelage.fermer() }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        indication.isHidden = true
        rechargerPortail.isHidden = true
        if let url = webView.url, estLocal(url) {
            destinationPortail = url.path + (url.query.map { "?\($0)" } ?? "")
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        afficherErreurWeb(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        afficherErreurWeb(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard dernierRedemarrageWeb.map({ Date().timeIntervalSince($0) > 20 }) ?? true else {
            indication.stringValue = "The SideRelay window stopped responding."
            indication.isHidden = false
            rechargerPortail.isHidden = false
            return
        }
        dernierRedemarrageWeb = Date()
        afficher(chemin: destinationPortail ?? "/", activer: false)
    }

    private func afficherErreurWeb(_ error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        indication.stringValue = "The signing portal did not load."
        indication.isHidden = false
        rechargerPortail.isHidden = false
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping @MainActor ([URL]?) -> Void) {
        guard frame.isMainFrame, estLocal(webView.url) else {
            completionHandler(nil)
            return
        }
        let panneau = NSOpenPanel()
        panneau.allowsMultipleSelection = parameters.allowsMultipleSelection
        panneau.canChooseFiles = true
        panneau.canChooseDirectories = parameters.allowsDirectories
        panneau.beginSheetModal(for: fenetre) { reponse in
            completionHandler(reponse == .OK ? panneau.urls : nil)
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (Bool) -> Void) {
        guard frame.isMainFrame, estLocal(webView.url) else {
            completionHandler(false)
            return
        }
        let confirmation = NSAlert()
        confirmation.messageText = message
        confirmation.addButton(withTitle: "Cancel")
        confirmation.addButton(withTitle: "Continue")
        confirmation.beginSheetModal(for: fenetre) { reponse in
            completionHandler(reponse == .alertSecondButtonReturn)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let importLiveContainer, importLiveContainer.isRunning { importLiveContainer.terminate() }
        if let companionService, companionService.isRunning { companionService.terminate() }
        jumelage.fermer(force: true)
        chargement?.cancel()
        chargementMenu?.cancel()
        atelier.arreterCapture()
        if moteur?.isRunning == true { moteur?.terminate() }
    }
}

@MainActor
private final class ChoixMenu: NSObject {
    var selection = ""

    @objc func selectionner(_ item: NSMenuItem) {
        selection = item.representedObject as? String ?? ""
    }
}

private enum ErreurPortail: Error {
    case indisponible
    case demandeInvalide
}

@MainActor
private final class PontComptes: NSObject, WKScriptMessageHandlerWithReply {
    private let traiter: (WKScriptMessage) async throws -> Any

    init(traiter: @escaping (WKScriptMessage) async throws -> Any) {
        self.traiter = traiter
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor (Any?, String?) -> Void) {
        Task { @MainActor in
            do { replyHandler(try await traiter(message), nil) }
            catch { replyHandler(nil, "The SideRelay request could not be completed.") }
        }
    }
}
