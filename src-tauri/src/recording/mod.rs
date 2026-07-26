// Transcription backend for the agent's voice features.
//
// Hosts the Deepgram key custody (`keys`) and the cloud speech-to-text +
// text-to-speech helpers (`transcribe`) used by voice dictation (the composer
// mic) and voice mode. The meeting-recording capture pipeline that also lived
// here was removed.

pub mod keys;
pub mod transcribe;
