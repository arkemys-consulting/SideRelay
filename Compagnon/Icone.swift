import AppKit
import ImageIO
import UniformTypeIdentifiers

@main
struct IconeCompagnon {
    @MainActor
    static func main() throws {
        let sortie = URL(fileURLWithPath: CommandLine.arguments[1])
        guard let pixels = Int(CommandLine.arguments[2]), pixels > 0,
              let hauteur = Int(CommandLine.arguments.count > 3 ? CommandLine.arguments[3] : CommandLine.arguments[2]),
              hauteur > 0, hauteur <= pixels,
              let rgb = CGColorSpace(name: CGColorSpace.sRGB),
              let contexte = CGContext(data: nil, width: pixels, height: hauteur,
                                       bitsPerComponent: 8, bytesPerRow: 0, space: rgb,
                                       bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else {
            throw CocoaError(.fileWriteUnknown)
        }

        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: contexte, flipped: false)
        let fond = CGRect(x: 0, y: 0, width: pixels, height: hauteur)
        contexte.setFillColor(CGColor(srgbRed: 0.08, green: 0.28, blue: 0.84, alpha: 1))
        contexte.fill(fond)
        dessinerSideRelay(NSRect(x: (pixels - hauteur) / 2, y: 0, width: hauteur, height: hauteur),
                          modele: false, fondPlein: true)
        NSGraphicsContext.restoreGraphicsState()

        let format = sortie.pathExtension == "jpg" ? UTType.jpeg : UTType.png
        guard let image = contexte.makeImage(),
              let destination = CGImageDestinationCreateWithURL(sortie as CFURL, format.identifier as CFString, 1, nil) else {
            throw CocoaError(.fileWriteUnknown)
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { throw CocoaError(.fileWriteUnknown) }
    }
}
