import Darwin
import Foundation
import SystemConfiguration
import dnssd

struct ResultatBonjour: Sendable {
    struct Appareil: Sendable {
        let nom: String
        let adresse: String
        let jumelageDistant: Bool
    }
    var statut = "ready"
    var appareils: [Appareil] = []
}

// Read the two relevant Bonjour service types. Discovery does not open a connection to an iPhone.
enum DecouverteBonjour {
    static let services = ["_remotepairing._tcp", "_apple-mobdev2._tcp"]

    private struct Service: Hashable {
        let nom: String
        let type: String
        let domaine: String
        let interface: UInt32
    }
    private final class Collecte {
        var services: Set<Service> = []
        var hotes: [Service: String] = [:]
        var adresses: [String: String] = [:]
        var erreurs: Set<DNSServiceErrorType> = []
    }

    private final class Resolution {
        let service: Service
        let collecte: Collecte

        init(service: Service, collecte: Collecte) {
            self.service = service
            self.collecte = collecte
        }
    }

    static func rechercher() -> ResultatBonjour {
        let collecte = Collecte()
        let contexte = Unmanaged.passUnretained(collecte).toOpaque()
        var recherches: [DNSServiceRef] = []
        for type in services {
            var ref: DNSServiceRef?
            let erreur = DNSServiceBrowse(&ref, 0, 0, type, "local.", { _, flags, index, erreur, nom, type, domaine, contexte in
                guard let contexte else { return }
                let collecte = Unmanaged<Collecte>.fromOpaque(contexte).takeUnretainedValue()
                guard erreur == 0 else { collecte.erreurs.insert(erreur); return }
                guard let nom, let type, let domaine else { return }
                let service = Service(nom: String(cString: nom), type: String(cString: type),
                                      domaine: String(cString: domaine), interface: index)
                if flags & UInt32(kDNSServiceFlagsAdd) != 0 { collecte.services.insert(service) }
                else { collecte.services.remove(service) }
            }, contexte)
            if let ref { recherches.append(ref) }
            else if erreur != 0 { collecte.erreurs.insert(erreur) }
        }
        traiter(recherches, pendant: 1.55, collecte: collecte)
        if collecte.services.isEmpty, !collecte.erreurs.isEmpty {
            let autorisation = collecte.erreurs.contains(DNSServiceErrorType(kDNSServiceErr_PolicyDenied))
                || collecte.erreurs.contains(DNSServiceErrorType(kDNSServiceErr_NoAuth))
            return ResultatBonjour(statut: autorisation ? "permission" : "unavailable")
        }

        // Retain the original interface when resolving each service.
        let candidats = collecte.services.sorted { ($0.nom, $0.type, $0.interface) < ($1.nom, $1.type, $1.interface) }
        let contextes = candidats.prefix(64).map { Resolution(service: $0, collecte: collecte) }
        let resolutions = contextes.compactMap { resolution -> DNSServiceRef? in
            let service = resolution.service
            var ref: DNSServiceRef?
            _ = DNSServiceResolve(&ref, 0, service.interface, service.nom, service.type, service.domaine, {
                _, _, _, erreur, _, hote, _, _, _, contexte in
                guard erreur == 0, let contexte, let hote else { return }
                let resolution = Unmanaged<Resolution>.fromOpaque(contexte).takeUnretainedValue()
                resolution.collecte.hotes[resolution.service] = String(cString: hote)
            }, Unmanaged.passUnretained(resolution).toOpaque())
            return ref
        }
        withExtendedLifetime(contextes) { traiter(resolutions, pendant: 1.25, collecte: collecte) }

        var refsAdresse: [DNSServiceRef] = []
        var demandes: Set<String> = []
        for (service, hote) in collecte.hotes {
            guard demandes.insert("\(service.interface)|\(hote)").inserted else { continue }
            var ref: DNSServiceRef?
            _ = DNSServiceGetAddrInfo(&ref, 0, service.interface, UInt32(kDNSServiceProtocol_IPv4), hote, {
                _, flags, index, erreur, hote, adresse, _, contexte in
                guard erreur == 0, flags & UInt32(kDNSServiceFlagsAdd) != 0, let contexte, let hote, let adresse,
                      adresse.pointee.sa_family == AF_INET else { return }
                var ip = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
                guard getnameinfo(adresse, socklen_t(adresse.pointee.sa_len), &ip, socklen_t(ip.count),
                                  nil, 0, NI_NUMERICHOST) == 0 else { return }
                let collecte = Unmanaged<Collecte>.fromOpaque(contexte).takeUnretainedValue()
                collecte.adresses["\(index)|\(String(cString: hote).lowercased())"] =
                    String(decoding: ip.prefix(while: { $0 != 0 }).map { UInt8(bitPattern: $0) }, as: UTF8.self)
            }, contexte)
            if let ref { refsAdresse.append(ref) }
        }
        traiter(refsAdresse, pendant: 1.15, collecte: collecte)

        let ipv4 = SCDynamicStoreCopyValue(nil, "State:/Network/Global/IPv4" as CFString) as? [String: Any]
        let principale = (ipv4?["PrimaryInterface"] as? String).map { if_nametoindex($0) }
        var parHote: [String: (appareil: ResultatBonjour.Appareil, priorite: Int)] = [:]
        for (service, hote) in collecte.hotes {
            let cle = hote.lowercased()
            guard let adresse = collecte.adresses["\(service.interface)|\(cle)"], !adresse.hasPrefix("127.") else { continue }
            let nom = cle.hasSuffix(".local.") ? String(hote.dropLast(7)) : hote
            let typeHote = nom.lowercased().filter(\.isLetter)
            guard !typeHote.contains("appletv") else { continue }
            let distant = service.type.hasPrefix(services[0])
            let priorite = (distant ? 4 : 0) + (service.interface == principale ? 2 : 0)
                + (adresse.hasPrefix("169.254.") ? 0 : 1)
            if let ancien = parHote[cle], (ancien.priorite, ancien.appareil.adresse) >= (priorite, adresse) {
                continue
            }
            parHote[cle] = (.init(nom: nom, adresse: adresse, jumelageDistant: distant), priorite)
        }
        return ResultatBonjour(appareils: parHote.values.map(\.appareil).sorted {
            $0.nom.localizedStandardCompare($1.nom) == .orderedAscending
        })
    }

    private static func traiter(_ refs: [DNSServiceRef], pendant secondes: TimeInterval, collecte: Collecte) {
        defer { refs.forEach { DNSServiceRefDeallocate($0) } }
        var sockets = refs.map { pollfd(fd: DNSServiceRefSockFD($0), events: Int16(POLLIN), revents: 0) }
        let fin = DispatchTime.now() + secondes
        while sockets.contains(where: { $0.fd >= 0 }) {
            let maintenant = DispatchTime.now()
            guard maintenant < fin else { return }
            let delai = Int32((fin.uptimeNanoseconds - maintenant.uptimeNanoseconds) / 1_000_000 + 1)
            let prets = poll(&sockets, nfds_t(sockets.count), delai)
            if prets < 0 && errno == EINTR { continue }
            guard prets > 0 else { return }
            for i in sockets.indices where sockets[i].revents != 0 {
                if sockets[i].revents & Int16(POLLIN) != 0 {
                    let erreur = DNSServiceProcessResult(refs[i])
                    if erreur == 0 { continue }
                    collecte.erreurs.insert(erreur)
                }
                sockets[i].fd = -1
            }
        }
    }
}
