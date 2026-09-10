import { Config } from "@remotion/cli/config";
// PNG, not JPEG. Every intermediate frame is lossless, which matters here
// because most of the film is screen recording: JPEG rings around small white
// text on a dark UI, and no amount of encoder quality afterwards recovers it.
Config.setVideoImageFormat("png");
Config.setOverwriteOutput(true);
Config.setConcurrency(4);
