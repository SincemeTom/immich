import 'package:immich_mobile/platform/connectivity_api.g.dart';
import 'package:immich_mobile/repositories/partner_api.repository.dart';
import 'package:mocktail/mocktail.dart';
import 'package:openapi/api.dart';

class MockSyncApi extends Mock implements SyncApi {}

class MockServerApi extends Mock implements ServerApi {}

class MockPartnerApiRepository extends Mock implements PartnerApiRepository {}

class MockConnectivityApi extends Mock implements ConnectivityApi {}

class MockUsersApi extends Mock implements UsersApi {}

class MockAuthenticationApi extends Mock implements AuthenticationApi {}

class MockSessionsApi extends Mock implements SessionsApi {}
