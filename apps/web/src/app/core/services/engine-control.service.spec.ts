import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { EngineControlService } from './engine-control.service';

describe('EngineControlService — politique horaires des actions manuelles', () => {
  let service: EngineControlService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [EngineControlService, provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(EngineControlService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('CUT standard omet disableSchedule : les horaires restent actifs', () => {
    service.requestCommand('tracker-1', 'CUT', 'test').subscribe();
    const req = http.expectOne('/api/engine-control/trackers/tracker-1/commands');
    expect(req.request.body.action).toBe('CUT');
    expect(req.request.body.disableSchedule).toBeUndefined();
    expect(req.request.body.idempotencyKey).toBeTruthy();
    req.flush({});
  });

  it('RESTORE standard omet disableSchedule : les horaires restent actifs', () => {
    service.requestCommand('tracker-1', 'RESTORE').subscribe();
    const req = http.expectOne('/api/engine-control/trackers/tracker-1/commands');
    expect(req.request.body.action).toBe('RESTORE');
    expect(req.request.body.disableSchedule).toBeUndefined();
    req.flush({});
  });

  it('seule l’option durable explicite envoie disableSchedule=true', () => {
    service.requestCommand('tracker-1', 'CUT', 'antivol', true).subscribe();
    const req = http.expectOne('/api/engine-control/trackers/tracker-1/commands');
    expect(req.request.body).toEqual(jasmine.objectContaining({
      action: 'CUT', reason: 'antivol', disableSchedule: true,
    }));
    req.flush({});
  });
});
