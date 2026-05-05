/**
 * Return type for AppModule.handleMessage.
 *
 * void (undefined): message was handled; router does nothing further.
 * {handled: false}: message was not handled; router yields to chatbot fallback.
 * {handled: true}: message was handled explicitly; same effect as void.
 *
 * Legacy apps that return void are treated as handled (no fallback).
 */
export type HandlerResult = undefined | { handled: boolean };
