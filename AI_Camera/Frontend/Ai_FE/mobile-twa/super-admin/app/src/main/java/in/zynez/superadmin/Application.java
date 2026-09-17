/*
 * Copyright 2020 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package in.zynez.superadmin;



public class Application extends android.app.Application {

  

  @Override
  public void onCreate() {
      super.onCreate();

      // New Lead alert channel — created here (app process start) so it
      // already exists with the right sound/importance before the very
      // first "New Lead Received" push ever arrives; DelegationService
      // also calls this defensively before posting one, in case this
      // process was started some other way (e.g. woken directly for the
      // push) without Application.onCreate() running first.
      LeadAlertChannel.ensureCreated(this);
  }
}
