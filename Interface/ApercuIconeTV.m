#import <AppKit/AppKit.h>
#import <dlfcn.h>

// CoreUI reads compiled tvOS image stacks. Keep this private API in a separate
// process so an unsupported catalogue never prevents SideRelay from loading.
@interface NSObject (SideRelayTVIcon)
- (instancetype)initWithURL:(NSURL *)url error:(NSError **)error;
- (id)layerStackWithName:(NSString *)name scaleFactor:(CGFloat)scale deviceIdiom:(NSInteger)idiom;
- (CGImageRef)flattenedImage;
@end

static NSData *iconPNG(CGImageRef image) {
    size_t width = CGImageGetWidth(image);
    size_t height = CGImageGetHeight(image);
    if (width == 0 || height == 0 || width > 2048 || height > 2048) return nil;

    double scale = MIN(1.0, 96.0 / MAX(width, height));
    size_t previewWidth = MAX(1, lround(width * scale));
    size_t previewHeight = MAX(1, lround(height * scale));
    CGColorSpaceRef color = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    if (!color) return nil;
    CGContextRef context = CGBitmapContextCreate(NULL, previewWidth, previewHeight, 8, 0, color,
                                                 (CGBitmapInfo)kCGImageAlphaPremultipliedLast);
    CGColorSpaceRelease(color);
    if (!context) return nil;

    CGContextSetInterpolationQuality(context, kCGInterpolationHigh);
    CGContextDrawImage(context, CGRectMake(0, 0, previewWidth, previewHeight), image);
    CGImageRef thumbnail = CGBitmapContextCreateImage(context);
    CGContextRelease(context);
    if (!thumbnail) return nil;

    NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithCGImage:thumbnail];
    CGImageRelease(thumbnail);
    return [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
}

int main(int argc, const char *argv[]) {
    if (argc != 3) return 1;
    @autoreleasepool {
        dlopen("/System/Library/PrivateFrameworks/CoreUI.framework/CoreUI", RTLD_LAZY | RTLD_LOCAL);
        Class catalogClass = NSClassFromString(@"CUICatalog");
        if (![catalogClass instancesRespondToSelector:@selector(initWithURL:error:)] ||
            ![catalogClass instancesRespondToSelector:@selector(layerStackWithName:scaleFactor:deviceIdiom:)]) return 1;

        id catalog = [[catalogClass alloc] initWithURL:[NSURL fileURLWithPath:@(argv[1])] error:nil];
        static const NSInteger tvIdiom = 3;
        for (NSInteger scale = 2; scale >= 1; scale--) {
            id stack = [catalog layerStackWithName:@(argv[2]) scaleFactor:scale deviceIdiom:tvIdiom];
            if (![stack respondsToSelector:@selector(flattenedImage)]) continue;
            CGImageRef image = [stack flattenedImage];
            NSData *png = image ? iconPNG(image) : nil;
            if (png.length > 0) {
                [NSFileHandle.fileHandleWithStandardOutput writeData:png];
                return 0;
            }
        }
    }
    return 1;
}
