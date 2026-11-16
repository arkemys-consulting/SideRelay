import Foundation

@main
struct DecouverteOrbStack {
    @MainActor
    static func main() async throws {
        let args = CommandLine.arguments
        if args.count == 4, args[1] == "pair", let port = UInt16(args[2]),
           let origin = URL(string: "http://127.0.0.1:\(port)") {
            let pair = Jumelage(origine: origin, executable: URL(fileURLWithPath: args[3]),
                                portalToken: ProcessInfo.processInfo.environment["SIDERELAY_PAIRING_TOKEN"])
            let input = AsyncStream<String> { continuation in
                Thread.detachNewThread {
                    while let line = readLine() { continuation.yield(line) }
                    continuation.finish()
                }
            }
            for await line in input {
                let query = (try? JSONDecoder().decode([String: String].self, from: Data(line.utf8))) ?? [:]
                let state: [String: String]
                switch query["action"] {
                case "startPairing":
                    state = pair.commencer(mode: query["mode"] ?? "", appareil: query["device"] ?? "",
                                           adresse: query["address"] ?? "", simplifiedUSB: query["simplifiedUSB"] == "1")
                case "retryPairing":
                    state = pair.reessayer(adresse: query["address"] ?? "")
                case "pairingStatus":
                    state = pair.etat
                case "closePairing":
                    pair.fermer()
                    state = pair.etat
                default:
                    state = ["stage": "invalidSelection"]
                }
                try respond(state)
            }
            pair.fermer(force: true)
            return
        }
        let resultat = DecouverteBonjour.rechercher()
        let appareils: [[String: Any]] = resultat.appareils.map {
            ["name": $0.nom, "address": $0.adresse, "remotePairing": $0.jumelageDistant]
        }
        let reponse: [String: Any] = ["status": resultat.statut, "devices": appareils]
        try respond(reponse)
    }

    static func respond(_ value: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: value)
        try FileHandle.standardOutput.write(contentsOf: data + Data([10]))
    }
}
