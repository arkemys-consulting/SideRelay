import AppKit
import ImageIO
import UniformTypeIdentifiers

@main
struct IconeCompagnon {
    @MainActor
    static func main() throws {
        let sortie = URL(fileURLWithPath: CommandLine.arguments[1])
        guard let pixels = Int(CommandLine.arguments[2]), pixels > 0,
              let rgb = CGColorSpace(name: CGColorSpace.sRGB),
              let contexte = CGContext(data: nil, width: pixels, height: pixels,
                                       bitsPerComponent: 8, bytesPerRow: 0, space: rgb,
                                       bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else {
            throw CocoaError(.fileWriteUnknown)
        }

        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: contexte, flipped: false)
        dessinerSideRelay(NSRect(x: 0, y: 0, width: pixels, height: pixels), modele: false, fondPlein: true)
        NSGraphicsContext.restoreGraphicsState()

        guard let image = contexte.makeImage(),
              let destination = CGImageDestinationCreateWithURL(sortie as CFURL, UTType.png.identifier as CFString, 1, nil) else {
            throw CocoaError(.fileWriteUnknown)
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { throw CocoaError(.fileWriteUnknown) }
    }
}
