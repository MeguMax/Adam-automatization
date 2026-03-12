export interface ParsedEmailInfo {
    courtName: string | null;
    caseNumber: string | null;
    plaintiff: string | null;
    defendant: string | null;
    fileTypeByAttachmentId: Record<string, string>; // attachmentId -> File Type
}

export interface ProcessedAttachment {
    originalName: string;
    newName: string;
    downloadUrl: string;
}

// types.ts
export interface NotificationFile {
    displayName: string;        // логическое имя: "Complaint for Possession Only"
    fileName: string;           // имя PDF в OneDrive
    buffer: Buffer;             // сам PDF для вложения
    driveId: string;            // куда залили
    itemId: string;             // id папки (или самого файла, см. ниже)
    webUrl?: string;            // ссылка просмотр в OneDrive
}
