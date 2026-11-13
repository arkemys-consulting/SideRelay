import Foundation
import LocalAuthentication
import Security

struct IdentifiantsApple: Codable {
    let identifiant: String
    let motDePasse: String
}

struct Trousseau {
    let service: String

    private var recherche: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "Apple Account",
            kSecAttrSynchronizable as String: false,
        ]
    }

    func lire() throws -> IdentifiantsApple? {
        var requete = recherche
        requete[kSecReturnData as String] = true
        requete[kSecMatchLimit as String] = kSecMatchLimitOne
        var resultat: CFTypeRef?
        let statut = SecItemCopyMatching(requete as CFDictionary, &resultat)
        if statut == errSecItemNotFound { return nil }
        try verifier(statut)
        guard let donnees = resultat as? Data else { throw ErreurTrousseau.lecture }
        return try JSONDecoder().decode(IdentifiantsApple.self, from: donnees)
    }

    func contientUnCompte() -> Bool {
        var requete = recherche
        let contexte = LAContext()
        contexte.interactionNotAllowed = true
        requete[kSecUseAuthenticationContext as String] = contexte
        requete[kSecMatchLimit as String] = kSecMatchLimitOne
        let statut = SecItemCopyMatching(requete as CFDictionary, nil)
        return statut == errSecSuccess || statut == errSecInteractionNotAllowed
    }

    func enregistrer(_ identifiants: IdentifiantsApple) throws {
        let donnees = try JSONEncoder().encode(identifiants)
        let attributs = [kSecValueData as String: donnees]
        let statut = SecItemUpdate(recherche as CFDictionary, attributs as CFDictionary)
        if statut == errSecItemNotFound {
            let entree = recherche.merging(attributs) { _, nouvelle in nouvelle }
            try verifier(SecItemAdd(entree as CFDictionary, nil))
        } else {
            try verifier(statut)
        }
    }

    private func verifier(_ statut: OSStatus) throws {
        if statut != errSecSuccess { throw ErreurTrousseau.systeme(statut) }
    }
}

enum ErreurTrousseau: Error {
    case lecture
    case systeme(OSStatus)
}
