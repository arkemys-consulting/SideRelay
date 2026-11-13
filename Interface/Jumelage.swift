import Darwin
import Foundation
import SystemConfiguration

@MainActor
final class Jumelage {
    private struct Evenement: Decodable {
        let stage: String
        let code: String?
        let record: String?
        let address: String?
    }

    private let origine: URL
    private let session: URLSession
    private var processus: Process?
    private var operation: Task<Void, Never>?
    private var tentative = UUID()
    private var donnees: Data?
    private var adresseWifi: String?
    private(set) var etat: [String: String] = ["stage": "idle"]

    init(origine: URL) {
        self.origine = origine
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 28
        configuration.timeoutIntervalForResource = 32
        configuration.httpShouldSetCookies = false
        self.session = URLSession(configuration: configuration, delegate: SansRedirection(), delegateQueue: nil)
    }

    func commencer(mode: String, appareil: String, adresse: String, simplifiedUSB: Bool = false) -> [String: String] {
        guard operation == nil else { return etat }
        let parametre: String
        var hostLabel: String?
        switch mode {
        case "usb":
            guard appareil.range(of: "^[0-9a-fA-F-]{8,64}$", options: .regularExpression) != nil,
                  Self.ipv4(adresse) else { return ["stage": "invalidSelection"] }
            parametre = appareil
            // This preference is an opaque label, not the pairing key. The engine stores the key encrypted.
            let cle = "usb-pairing-host-\(appareil.replacingOccurrences(of: "-", with: "").uppercased())"
            let preferences = UserDefaults.standard
            let label = preferences.string(forKey: cle) ?? "SideRelay-\(UUID().uuidString.prefix(12))"
            preferences.set(label, forKey: cle)
            hostLabel = label
        case "wifi":
            guard adresse.isEmpty || Self.ipv4(adresse) else { return ["stage": "invalidSelection"] }
            guard let locale = Self.adresseLocale() else { return ["stage": "wifiNoNetwork"] }
            parametre = locale
        default:
            return ["stage": "invalidSelection"]
        }
        guard let executable = Bundle.main.url(forAuxiliaryExecutable: "siderelay-pair") else {
            return ["stage": "startFailed"]
        }
        donnees = nil
        adresseWifi = nil
        tentative = UUID()
        let id = tentative
        let outil = Process()
        let tuyau = Pipe()
        let lecteur = tuyau.fileHandleForReading
        outil.executableURL = executable
        outil.arguments = [mode == "usb" && simplifiedUSB ? "usb-simple" : mode, parametre] + (hostLabel.map { [$0] } ?? [])
        outil.standardInput = FileHandle.nullDevice
        outil.standardOutput = tuyau
        outil.standardError = FileHandle.nullDevice
        outil.environment = ["PATH": "/usr/bin:/bin"]
        let flux = AsyncStream<Data> { continuation in
            lecteur.readabilityHandler = { descripteur in
                let bloc = descripteur.availableData
                if bloc.isEmpty { descripteur.readabilityHandler = nil; continuation.finish() }
                else { continuation.yield(bloc) }
            }
        }
        do { try outil.run() }
        catch {
            lecteur.readabilityHandler = nil
            return ["stage": "startFailed"]
        }
        processus = outil
        etat = ["stage": "starting"]
        operation = Task { [weak self] in
            guard let self else { return }
            defer {
                lecteur.readabilityHandler = nil
                if self.tentative == id {
                    self.processus = nil
                    self.operation = nil
                }
            }
            var tampon = Data()
            for await bloc in flux {
                guard self.tentative == id, !Task.isCancelled else { return }
                tampon.append(bloc)
                guard tampon.count <= 65_536 else {
                    if outil.isRunning { outil.terminate() }
                    self.etat = ["stage": "startFailed"]
                    return
                }
                while let fin = tampon.firstIndex(of: 10) {
                    let ligne = Data(tampon[..<fin])
                    tampon.removeSubrange(...fin)
                    guard let message = try? JSONDecoder().decode(Evenement.self, from: ligne) else { continue }
                    if message.stage == "record" {
                        guard let texte = message.record, let cle = Data(base64Encoded: texte),
                              !cle.isEmpty, cle.count <= 32_768 else {
                            self.etat = ["stage": "startFailed"]
                            return
                        }
                        self.donnees = cle
                        self.adresseWifi = message.address
                        await self.enregistrer(adresse: adresse, tentative: id)
                        return
                    }
                    if message.stage == "wifiCode", let code = message.code,
                       code.range(of: "^[0-9]{6}$", options: .regularExpression) != nil {
                        self.etat = ["stage": "wifiCode", "code": code]
                    } else {
                        self.etat = ["stage": message.stage]
                    }
                }
            }
            if self.tentative == id, ["starting", "usbConnect", "usbApprove", "usbConfirm", "wifiWait", "wifiConnected", "wifiCode"].contains(self.etat["stage"] ?? "") {
                self.etat = ["stage": "startFailed"]
            }
        }
        return etat
    }

    func reessayer(adresse: String) -> [String: String] {
        guard operation == nil, donnees != nil else { return etat }
        let id = tentative
        etat = ["stage": "verifying"]
        operation = Task { [weak self] in
            guard let self else { return }
            await self.enregistrer(adresse: adresse, tentative: id)
            if self.tentative == id { self.operation = nil }
        }
        return etat
    }

    func fermer(force: Bool = false) {
        guard force || etat["stage"] != "verifying" else { return }
        tentative = UUID()
        operation?.cancel()
        operation = nil
        if let processus, processus.isRunning { processus.terminate() }
        processus = nil
        donnees = nil
        adresseWifi = nil
        etat = ["stage": "idle"]
    }

    private func enregistrer(adresse: String, tentative id: UUID) async {
        guard let donnees else { etat = ["stage": "startFailed"]; return }
        let destination = adresse.isEmpty ? adresseWifi ?? "" : adresse
        guard Self.ipv4(destination) else { etat = ["stage": "addressRequired"]; return }
        etat = ["stage": "verifying"]
        var requete = URLRequest(url: origine.appendingPathComponent("api/register_device11318273670462819093"))
        requete.httpMethod = "POST"
        requete.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        requete.setValue("application/json", forHTTPHeaderField: "Accept")
        let alphabet = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        guard let secret = donnees.base64EncodedString().addingPercentEncoding(withAllowedCharacters: alphabet) else {
            etat = ["stage": "startFailed"]
            return
        }
        requete.httpBody = Data("ip=\(destination)&pairing_blob_b64=\(secret)".utf8)
        do {
            let (corps, reponse) = try await session.data(for: requete)
            guard tentative == id, !Task.isCancelled else { return }
            guard let http = reponse as? HTTPURLResponse, http.url == requete.url else {
                etat = ["stage": "verifyFailed"]
                return
            }
            if http.statusCode == 200,
               let appareil = try? JSONDecoder().decode(String.self, from: corps), UUID(uuidString: appareil) != nil {
                self.donnees = nil
                etat = ["stage": "added"]
            } else {
                let raison = String(decoding: corps, as: UTF8.self)
                if raison.contains("UNIQUE constraint failed: devices.udid") {
                    self.donnees = nil
                    etat = ["stage": "alreadyAdded"]
                } else if raison.contains("RPPairing verification failed") {
                    etat = ["stage": "recordRejected"]
                } else if raison.contains("TCP connect to") && raison.contains(":49152") {
                    etat = ["stage": "unreachable"]
                } else if raison.contains("CDTunnel") || raison.contains("TLS-PSK tunnel") {
                    etat = ["stage": "tunnelFailed"]
                } else {
                    etat = ["stage": "verifyFailed"]
                }
            }
        } catch {
            if tentative == id, !Task.isCancelled { etat = ["stage": "verifyFailed"] }
        }
    }

    private static func ipv4(_ valeur: String) -> Bool {
        var adresse = in_addr()
        guard inet_pton(AF_INET, valeur, &adresse) == 1 else { return false }
        let premier = UInt32(bigEndian: adresse.s_addr) >> 24
        return premier > 0 && premier < 224 && premier != 127
    }

    private static func adresseLocale() -> String? {
        let etat = SCDynamicStoreCopyValue(nil, "State:/Network/Global/IPv4" as CFString) as? [String: Any]
        let principale = etat?["PrimaryInterface"] as? String
        var interfaces: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&interfaces) == 0 else { return nil }
        defer { freeifaddrs(interfaces) }
        var repli: String?
        var courant = interfaces
        while let element = courant {
            let interface = element.pointee
            courant = interface.ifa_next
            guard let adresse = interface.ifa_addr, adresse.pointee.sa_family == AF_INET,
                  interface.ifa_flags & UInt32(IFF_UP) != 0 else { continue }
            let nom = String(cString: interface.ifa_name)
            guard nom.hasPrefix("en") else { continue }
            var tampon = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
            guard getnameinfo(adresse, socklen_t(adresse.pointee.sa_len), &tampon, socklen_t(tampon.count),
                              nil, 0, NI_NUMERICHOST) == 0 else { continue }
            let ip = String(decoding: tampon.prefix(while: { $0 != 0 }).map { UInt8(bitPattern: $0) }, as: UTF8.self)
            guard ipv4(ip), !ip.hasPrefix("169.254.") else { continue }
            if nom == principale { return ip }
            if repli == nil { repli = ip }
        }
        return repli
    }
}

private final class SansRedirection: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
