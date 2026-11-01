// M4 research (macos/verification/m4-vision-research.md): what Apple's Vision framework says about a photo, and how
// long each request takes. Not part of a release.
//
// Reads one JSON object per line on stdin: {"path": "...", "tasks": ["classify", ...], "languages": ["zh-Hans", ...],
// "cpu": false}, and writes one per line on stdout, each request's result and milliseconds. Tasks: classify,
// aesthetics, ocr, ocr-fast, animals, barcodes, faces, featureprint; on macOS 26 also documents, smudge. "cpu": true
// keeps each request on the CPU, which tells whether the Neural Engine sped it up.
//
//   probe labels                  the classifier's identifiers
//   probe ocr-languages           the languages the text recognizer reads
//   probe qr TEXT OUT.png         a QR code (Core Image), for test images
//
// Build: swiftc -O -parse-as-library -o probe macos/vision/probe.swift

import CoreImage
import CoreML
import Foundation
import ImageIO
import Vision

struct Job: Decodable {
    let path: String
    let tasks: [String]
    let languages: [String]?
    let cpu: Bool?
    let minimumTextHeight: Float?  // as a fraction of the image's height; Vision's default is 1/32
}

func milliseconds(since start: ContinuousClock.Instant) -> Double {
    let elapsed = ContinuousClock.now - start
    return Double(elapsed.components.seconds) * 1000 + Double(elapsed.components.attoseconds) / 1e15
}

let cpuDevice: MLComputeDevice? = MLComputeDevice.allComputeDevices.first {
    if case .cpu = $0 { return true }
    return false
}

func onCPU<R: ImageProcessingRequest>(_ request: inout R, _ cpu: Bool) {
    guard cpu, let device = cpuDevice else { return }
    request.setComputeDevice(device, for: .main)
    request.setComputeDevice(device, for: .postProcessing)
}

func box(_ rect: NormalizedRect) -> [Double] {
    // Vision's origin is the bottom left; as fractions of the image, top left origin
    let r = rect.cgRect
    let values: [Double] = [Double(r.minX), Double(1 - r.maxY), Double(r.width), Double(r.height)]
    return values.map { ($0 * 10000).rounded() / 10000 }
}

func lines(_ observations: [RecognizedTextObservation]) -> [[String: Any]] {
    observations.compactMap { observation in
        guard let best = observation.topCandidates(1).first else { return nil }
        return ["text": best.string, "confidence": best.confidence]
    }
}

func run(_ job: Job) async -> [String: Any] {
    let url = URL(fileURLWithPath: job.path)
    let handler = ImageRequestHandler(url)
    let cpu = job.cpu ?? false
    var out: [String: Any] = ["path": job.path]
    var timings: [String: Double] = [:]
    for task in job.tasks {
        let start = ContinuousClock.now
        do {
            switch task {
            case "classify":
                var request = ClassifyImageRequest()
                onCPU(&request, cpu)
                let results = try await handler.perform(request)
                out[task] = results.filter { $0.confidence >= 0.05 }.sorted { $0.confidence > $1.confidence }
                    .prefix(25).map { ["label": $0.identifier, "confidence": $0.confidence] }
            case "aesthetics":
                var request = CalculateImageAestheticsScoresRequest()
                onCPU(&request, cpu)
                let result = try await handler.perform(request)
                out[task] = ["score": result.overallScore, "utility": result.isUtility]
            case "ocr", "ocr-fast":
                var request = RecognizeTextRequest()
                onCPU(&request, cpu)
                request.recognitionLevel = task == "ocr" ? .accurate : .fast
                request.usesLanguageCorrection = task == "ocr"
                if let height = job.minimumTextHeight {
                    request.minimumTextHeightFraction = height
                }
                if let languages = job.languages {
                    request.recognitionLanguages = languages.map { Locale.Language(identifier: $0) }
                } else {
                    request.automaticallyDetectsLanguage = true
                }
                out[task] = lines(try await handler.perform(request))
            case "animals":
                var request = RecognizeAnimalsRequest()
                onCPU(&request, cpu)
                out[task] = try await handler.perform(request).map { animal in
                    ["label": animal.labels.first?.identifier ?? "", "confidence": animal.confidence,
                     "box": box(animal.boundingBox)] as [String: Any]
                }
            case "barcodes":
                var request = DetectBarcodesRequest()
                onCPU(&request, cpu)
                out[task] = try await handler.perform(request).map { code in
                    ["payload": code.payloadString ?? "", "symbology": "\(code.symbology)"]
                }
            case "faces":
                var detect = DetectFaceRectanglesRequest()
                onCPU(&detect, cpu)
                let faces = try await handler.perform(detect)
                var quality = DetectFaceCaptureQualityRequest()
                onCPU(&quality, cpu)
                quality.inputFaceObservations = faces
                let rated = faces.isEmpty ? [] : try await handler.perform(quality)
                out[task] = rated.map { face in
                    ["box": box(face.boundingBox), "confidence": face.confidence,
                     "quality": face.captureQuality?.score ?? -1] as [String: Any]
                }
            case "featureprint":
                var request = GenerateImageFeaturePrintRequest()
                onCPU(&request, cpu)
                let print = try await handler.perform(request)
                out[task] = ["elements": print.elementCount]
            case "documents":
                if #available(macOS 26.0, *) {
                    var request = RecognizeDocumentsRequest()
                    onCPU(&request, cpu)
                    out[task] = try await handler.perform(request).map { observation in
                        let document = observation.document
                        return ["confidence": observation.confidence, "lines": lines(document.text.lines),
                                "paragraphs": document.paragraphs.count, "tables": document.tables.count,
                                "lists": document.lists.count, "barcodes": document.barcodes.count,
                                "title": document.title.map { lines($0.lines).compactMap { $0["text"] } } ?? []]
                            as [String: Any]
                    }
                } else {
                    out[task] = "needs macOS 26"
                }
            case "smudge":
                if #available(macOS 26.0, *) {
                    var request = DetectLensSmudgeRequest()
                    onCPU(&request, cpu)
                    out[task] = ["confidence": try await handler.perform(request).confidence]
                } else {
                    out[task] = "needs macOS 26"
                }
            default:
                out[task] = "unknown task"
            }
        } catch {
            out[task] = ["error": "\(error)"]
        }
        timings[task] = (milliseconds(since: start) * 10).rounded() / 10
    }
    out["ms"] = timings
    return out
}

func qr(_ text: String, _ path: String) throws {
    let filter = CIFilter(name: "CIQRCodeGenerator")!
    filter.setValue(Data(text.utf8), forKey: "inputMessage")
    filter.setValue("M", forKey: "inputCorrectionLevel")
    let image = filter.outputImage!.transformed(by: CGAffineTransform(scaleX: 12, y: 12))
    let context = CIContext()
    try context.writePNGRepresentation(of: image, to: URL(fileURLWithPath: path), format: .RGBA8,
                                       colorSpace: CGColorSpaceCreateDeviceRGB())
}

@main
struct Probe {
    static func main() async throws {
        let arguments = CommandLine.arguments
        if arguments.count > 1 {
            switch arguments[1] {
            case "labels":
                print(ClassifyImageRequest().supportedIdentifiers.joined(separator: "\n"))
            case "ocr-languages":
                print(RecognizeTextRequest().supportedRecognitionLanguages.map { $0.maximalIdentifier }.joined(separator: "\n"))
            case "qr" where arguments.count == 4:
                try qr(arguments[2], arguments[3])
            default:
                FileHandle.standardError.write(Data("usage: probe [labels | ocr-languages | qr TEXT OUT.png]\n".utf8))
                exit(64)
            }
            return
        }
        let decoder = JSONDecoder()
        while let line = readLine() {
            guard let job = try? decoder.decode(Job.self, from: Data(line.utf8)) else {
                print("{\"error\": \"not a job\"}")
                continue
            }
            let result = await run(job)
            let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
            print(String(decoding: data, as: UTF8.self))
            fflush(stdout)
        }
    }
}
