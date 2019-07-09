/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ITextMateService } from 'vs/workbench/services/textMate/common/textMateService';
import { registerSingleton } from 'vs/platform/instantiation/common/extensions';
import { AbstractTextMateService } from 'vs/workbench/services/textMate/browser/abstractTextMateService';
import { IModeService } from 'vs/editor/common/services/modeService';
import { IWorkbenchThemeService } from 'vs/workbench/services/themes/common/workbenchThemeService';
import { IFileService } from 'vs/platform/files/common/files';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { ILogService } from 'vs/platform/log/common/log';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { createWebWorker, MonacoWebWorker } from 'vs/editor/common/services/webWorker';
import { IModelService } from 'vs/editor/common/services/modelService';
import { IOnigLib } from 'vscode-textmate';
import { IValidGrammarDefinition } from 'vs/workbench/services/textMate/common/TMScopeRegistry';
import { TextMateWorker } from 'vs/workbench/services/textMate/electron-browser/textMateWorker';
import { ITextModel } from 'vs/editor/common/model';
import { Disposable } from 'vs/base/common/lifecycle';
import { UriComponents, URI } from 'vs/base/common/uri';

const RUN_TEXTMATE_IN_WORKER = false;

class ModelWorkerTextMateTokenizer extends Disposable {

	private readonly _worker: TextMateWorker;
	private readonly _model: ITextModel;
	private _isSynced: boolean;

	constructor(worker: TextMateWorker, model: ITextModel) {
		super();
		this._worker = worker;
		this._model = model;
		this._isSynced = false;

		this._register(this._model.onDidChangeAttached(() => this._onDidChangeAttached()));
		this._onDidChangeAttached();

		this._register(this._model.onDidChangeContent((e) => {
			if (this._isSynced) {
				this._worker.acceptModelChanged(this._model.uri.toString(), e);
			}
		}));

		this._register(this._model.onDidChangeLanguage((e) => {
			if (this._isSynced) {
				this._worker.acceptModelLanguageChanged(this._model.uri.toString(), this._model.getLanguageIdentifier().id);
			}
		}));
	}

	private _onDidChangeAttached(): void {
		if (this._model.isAttachedToEditor()) {
			if (!this._isSynced) {
				this._beginSync();
			}
		} else {
			if (this._isSynced) {
				this._endSync();
			}
		}
	}

	private _beginSync(): void {
		this._isSynced = true;
		this._worker.acceptNewModel({
			uri: this._model.uri,
			versionId: this._model.getVersionId(),
			lines: this._model.getLinesContent(),
			EOL: this._model.getEOL(),
			languageId: this._model.getLanguageIdentifier().id,
		});
	}

	private _endSync(): void {
		this._worker.acceptRemovedModel(this._model.uri.toString());
	}

	public dispose() {
		super.dispose();
		this._endSync();
	}
}

export class TextMateWorkerHost {

	constructor(@IFileService private readonly _fileService: IFileService) {
	}

	async readFile(_resource: UriComponents): Promise<string> {
		const resource = URI.revive(_resource);
		const content = await this._fileService.readFile(resource);
		return content.value.toString();
	}
}

export class TextMateService extends AbstractTextMateService {

	private _worker: MonacoWebWorker<TextMateWorker> | null;
	private _workerProxy: TextMateWorker | null;
	private _tokenizers: { [uri: string]: ModelWorkerTextMateTokenizer; };

	constructor(
		@IModeService modeService: IModeService,
		@IWorkbenchThemeService themeService: IWorkbenchThemeService,
		@IFileService fileService: IFileService,
		@INotificationService notificationService: INotificationService,
		@ILogService logService: ILogService,
		@IConfigurationService configurationService: IConfigurationService,
		@IModelService private readonly _modelService: IModelService,
	) {
		super(modeService, themeService, fileService, notificationService, logService, configurationService);
		this._worker = null;
		this._workerProxy = null;
		this._tokenizers = Object.create(null);
		this._register(this._modelService.onModelAdded(model => this._onModelAdded(model)));
		this._register(this._modelService.onModelRemoved(model => this._onModelRemoved(model)));
		this._modelService.getModels().forEach((model) => this._onModelAdded(model));
	}

	private _onModelAdded(model: ITextModel): void {
		if (!this._workerProxy) {
			return;
		}
		if (model.isTooLargeForSyncing()) {
			return;
		}
		const key = model.uri.toString();
		const tokenizer = new ModelWorkerTextMateTokenizer(this._workerProxy, model);
		this._tokenizers[key] = tokenizer;
	}

	private _onModelRemoved(model: ITextModel): void {
		const key = model.uri.toString();
		if (this._tokenizers[key]) {
			this._tokenizers[key].dispose();
			delete this._tokenizers[key];
		}
	}

	protected _loadVSCodeTextmate(): Promise<typeof import('vscode-textmate')> {
		return import('vscode-textmate');
	}

	protected _loadOnigLib(): Promise<IOnigLib> | undefined {
		return undefined;
	}

	protected _onDidCreateGrammarFactory(grammarDefinitions: IValidGrammarDefinition[]): void {
		this._killWorker();

		if (RUN_TEXTMATE_IN_WORKER) {
			const workerHost = new TextMateWorkerHost(this._fileService);
			const worker = createWebWorker<TextMateWorker>(this._modelService, {
				createData: {
					grammarDefinitions
				},
				label: 'textMateWorker',
				moduleId: 'vs/workbench/services/textMate/electron-browser/textMateWorker',
				host: workerHost
			});

			this._worker = worker;
			worker.getProxy().then((proxy) => {
				if (this._worker !== worker) {
					// disposed in the meantime
					return;
				}
				this._workerProxy = proxy;
				this._modelService.getModels().forEach((model) => this._onModelAdded(model));
			});
		}
	}

	protected _onDidDisposeGrammarFactory(): void {
		this._killWorker();
	}

	private _killWorker(): void {
		for (let key of Object.keys(this._tokenizers)) {
			this._tokenizers[key].dispose();
		}
		this._tokenizers = Object.create(null);

		if (this._worker) {
			this._worker.dispose();
			this._worker = null;
		}
		this._workerProxy = null;
	}
}

registerSingleton(ITextMateService, TextMateService);