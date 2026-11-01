// immich-vision: what Apple's Vision framework says about a photo, for the server's content analysis
// (server/src/services/content-analysis.service.ts; macos/verification/m4-vision-research.md). The models are the
// system's, run on the Neural Engine; nothing ships with it.
//
// The server starts it once and keeps it: it reads one job per line on stdin, and writes its result as one line on
// stdout, in the order the jobs came.
//
//   {"id": "...", "path": "/…/preview.jpeg", "tasks": ["classify", "aesthetics", "animals", "barcodes"]}
//   {"id": "...", "classify": [{"label": "cat", "confidence": 0.93}, …], "aesthetics": {"score": 0.41,
//    "utility": false}, "animals": [{"label": "Cat", "confidence": 0.88}], "barcodes": [{"payload": "…",
//    "symbology": "QR"}], "ms": 31.2}
//
// A request that fails leaves {"error": "…"} as its result; a job it cannot read, {"id": …, "error": "…"}.
//
//   immich-vision version    the macOS version, and how many labels the classifier knows
//   immich-vision labels     the classifier's labels, one per line
//
// Build: swiftc -O -parse-as-library -target arm64-apple-macos15.0 -o immich-vision immich-vision.swift

import Foundation
import Vision

struct Job: Decodable {
    let id: String
    let path: String
    let tasks: [String]
}

func milliseconds(since start: ContinuousClock.Instant) -> Int {
    let elapsed = ContinuousClock.now - start
    return Int((Double(elapsed.components.seconds) * 1000 + Double(elapsed.components.attoseconds) / 1e15).rounded())
}

func rounded(_ value: Float) -> Double {
    (Double(value) * 10000).rounded() / 10000
}

func analyze(_ job: Job) async -> [String: Any] {
    var out: [String: Any] = ["id": job.id]
    guard FileManager.default.isReadableFile(atPath: job.path) else {
        out["error"] = "cannot read \(job.path)"
        return out
    }
    let handler = ImageRequestHandler(URL(fileURLWithPath: job.path))
    let start = ContinuousClock.now
    for task in job.tasks {
        do {
            switch task {
            case "classify":
                let results = try await handler.perform(ClassifyImageRequest())
                out[task] = results.filter { $0.confidence >= 0.1 }.sorted { $0.confidence > $1.confidence }
                    .prefix(30).map { ["label": $0.identifier, "confidence": rounded($0.confidence)] }
            case "aesthetics":
                let result = try await handler.perform(CalculateImageAestheticsScoresRequest())
                out[task] = ["score": rounded(result.overallScore), "utility": result.isUtility]
            case "animals":
                out[task] = try await handler.perform(RecognizeAnimalsRequest()).compactMap { animal -> [String: Any]? in
                    guard let label = animal.labels.first else { return nil }
                    return ["label": label.identifier, "confidence": rounded(label.confidence)]
                }
            case "barcodes":
                out[task] = try await handler.perform(DetectBarcodesRequest()).compactMap { code -> [String: Any]? in
                    guard let payload = code.payloadString else { return nil }
                    return ["payload": payload, "symbology": "\(code.symbology)"]
                }
            default:
                out[task] = ["error": "unknown task"]
            }
        } catch {
            out[task] = ["error": "\(error)"]
        }
    }
    out["ms"] = milliseconds(since: start)
    return out
}

func write(_ object: [String: Any]) {
    let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]))
        ?? Data("{\"error\": \"unencodable result\"}".utf8)
    FileHandle.standardOutput.write(data + Data("\n".utf8))
}

@main
struct ImmichVision {
    static func main() async {
        let arguments = CommandLine.arguments
        if arguments.count > 1 {
            let labels = ClassifyImageRequest().supportedIdentifiers
            switch arguments[1] {
            case "version":
                let os = ProcessInfo.processInfo.operatingSystemVersion
                print("immich-vision 1, macOS \(os.majorVersion).\(os.minorVersion).\(os.patchVersion), \(labels.count) labels")
            case "labels":
                print(labels.joined(separator: "\n"))
            default:
                FileHandle.standardError.write(Data("usage: immich-vision [version | labels]\n".utf8))
                exit(64)
            }
            return
        }
        let decoder = JSONDecoder()
        while let line = readLine() {
            guard !line.isEmpty else { continue }
            guard let job = try? decoder.decode(Job.self, from: Data(line.utf8)) else {
                let id = (try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])?["id"]
                write(["id": id ?? NSNull(), "error": "not a job"])
                continue
            }
            write(await analyze(job))
        }
    }
}
